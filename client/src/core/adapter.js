'use strict';

const crypto = require('node:crypto');
const { request } = require('./http');
const { bucketFor } = require('./ratelimit');
const { AuthError, ValidationError, QuoteClientError } = require('./errors');
const { validateRisk } = require('./contract');

/**
 * Declarative adapter factory.
 *
 * The goal: adding a carrier should be a CONFIG file, not code. Carriers differ in surface
 * detail (where the token goes, what the fields are called) far more than in substance, so this
 * module expresses those differences as data and keeps one code path for all of them.
 *
 * Drop to a custom function only when a carrier is genuinely strange - every hook below accepts
 * a function as well as a declaration, so an odd carrier never forces a fork of the framework.
 */

// --------------------------------------------------------------------------
// path + template helpers
// --------------------------------------------------------------------------

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, k) => {
    if (acc === null || acc === undefined) return undefined;
    // support numeric array indexes: items.0.name
    return acc[k];
  }, obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/** Substitute {a.b} references in a string from a context object. */
function template(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{([a-zA-Z0-9_.]+)\}/g, (whole, path) => {
    const v = getPath(ctx, path);
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Apply a mapping declaration to a source object.
 *
 * A mapping value may be:
 *   "a.b.c"                       copy from that source path
 *   { const: X }                  literal
 *   { path, default, transform }  copy with fallback and/or a transform function
 *   fn(source, ctx)               arbitrary
 *   { ...nested }                 nested mapping
 *
 * Keys whose resolved value is undefined are omitted entirely, so we never send
 * explicit nulls a carrier might reject.
 */
function applyMapping(mapping, source, ctx = {}) {
  if (typeof mapping === 'function') return mapping(source, ctx);
  if (mapping === null || mapping === undefined) return undefined;
  if (typeof mapping === 'string') return getPath(source, mapping);

  if (Array.isArray(mapping)) {
    return mapping.map((m) => applyMapping(m, source, ctx)).filter((v) => v !== undefined);
  }

  if (typeof mapping === 'object') {
    if ('const' in mapping) return mapping.const;

    if ('path' in mapping || 'transform' in mapping || 'default' in mapping) {
      let v = 'path' in mapping ? getPath(source, mapping.path) : source;
      if ((v === undefined || v === null || v === '') && 'default' in mapping) v = mapping.default;
      if (typeof mapping.transform === 'function' && v !== undefined) v = mapping.transform(v, source, ctx);
      return v;
    }

    const out = {};
    for (const [k, m] of Object.entries(mapping)) {
      const v = applyMapping(m, source, ctx);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  return mapping;
}

// --------------------------------------------------------------------------
// auth strategies
// --------------------------------------------------------------------------

/**
 * Returns { headers, query, token } to apply to the quote request.
 *
 * `secrets` is already-resolved plaintext. It is never logged - the redactor has each value
 * registered by the time we get here.
 */
async function authenticate(def, { secrets, config, logger, requestId }) {
  const auth = def.auth || { kind: 'none' };
  const ctx = { secrets, config };

  if (typeof auth === 'function') return auth(ctx);

  switch (auth.kind) {
    case 'none':
      return { headers: {}, query: {} };

    case 'basic': {
      const user = template(auth.username || '{secrets.username}', ctx);
      const pass = template(auth.password || '{secrets.password}', ctx);
      const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
      return { headers: { authorization: `Basic ${b64}` }, query: {} };
    }

    case 'api_key': {
      const value = template(auth.value || '{secrets.apiKey}', ctx);
      if (auth.in === 'query') return { headers: {}, query: { [auth.name || 'api_key']: value } };
      return { headers: { [auth.name || 'x-api-key']: value }, query: {} };
    }

    case 'bearer_static': {
      const value = template(auth.value || '{secrets.token}', ctx);
      return { headers: { authorization: `Bearer ${value}` }, query: {} };
    }

    /**
     * Generic token-exchange. Covers standard OAuth2 client-credentials AND carriers that
     * invented their own login endpoint returning an opaque token in a nonstandard field.
     */
    case 'token_endpoint': {
      const url = auth.url.startsWith('http') ? auth.url : `${config.baseUrl}${auth.url}`;
      const bodyObj = applyMapping(auth.body || {}, ctx, ctx) || {};

      let body;
      const headers = { accept: 'application/json', ...(auth.headers || {}) };
      if ((auth.bodyType || 'json') === 'form') {
        body = new URLSearchParams(bodyObj).toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        body = JSON.stringify(bodyObj);
        headers['content-type'] = 'application/json';
      }

      const res = await request(url, {
        method: auth.method || 'POST',
        headers,
        body,
        carrier: def.id,
        requestId,
        logger,
        allowInsecure: config.allowInsecure,
        timeoutMs: config.timeoutMs,
        retries: 1,
      });

      // Token may be a JSON field or, for some carriers, the raw body.
      let token;
      if (auth.tokenPath) token = getPath(res.json, auth.tokenPath);
      if (token === undefined && res.json) {
        token = res.json.access_token ?? res.json.token ?? res.json.Token ?? res.json.AccessToken;
      }
      if (token === undefined && res.text) {
        const t = res.text.trim().replace(/^"|"$/g, '');
        if (t && !t.startsWith('{') && !t.startsWith('<')) token = t;
      }

      if (!token) {
        throw new AuthError(
          `Carrier ${def.id} auth succeeded (HTTP ${res.status}) but no token was found. ` +
          `Set auth.tokenPath to the correct field.`,
          { carrier: def.id, requestId },
        );
      }

      // Register immediately so it can never reach a log, even via an error message.
      require('./redact').registerSecret(String(token));

      const applyCtx = { ...ctx, token };

      // applyHeaders / applyQuery values are TEMPLATES, not source paths. Running them through
      // applyMapping would treat "Bearer {token}" as a lookup path, resolve it to undefined, and
      // silently drop the Authorization header - which then shows up as a confusing 401.
      const toTemplated = (decl) => Object.fromEntries(
        Object.entries(decl || {}).map(([k, v]) => [k, template(String(v), applyCtx)]),
      );

      return {
        token,
        headers: toTemplated(auth.applyHeaders || { authorization: 'Bearer {token}' }),
        query: toTemplated(auth.applyQuery),
      };
    }

    default:
      throw new AuthError(`Unknown auth kind "${auth.kind}" for carrier ${def.id}.`, { carrier: def.id });
  }
}

// --------------------------------------------------------------------------
// adapter
// --------------------------------------------------------------------------

/**
 * @param {object} def carrier definition
 * @param {string} def.id            stable slug, e.g. "slide"
 * @param {string} def.label         human name
 * @param {object} def.config        { baseUrl, timeoutMs, allowInsecure, ... }
 * @param {object} def.secrets       { alias: vaultKeyName }
 * @param {object|Function} def.auth see authenticate()
 * @param {object} def.quote         { method, path, query, headers, body }
 * @param {object|Function} def.parse mapping from carrier response to canonical response
 * @param {object} def.limits        { ratePerSecond, burst }
 */
function defineAdapter(def) {
  if (!def || !def.id) throw new Error('Adapter definition requires an id.');

  return {
    id: def.id,
    label: def.label || def.id,
    definition: def,

    async quote(risk, { secretStore, logger, requestId = crypto.randomUUID(), overrides = {} } = {}) {
      const carrier = def.id;
      const log = logger?.child ? logger.child({ carrier, requestId }) : logger;

      // 1. Validate OUR canonical shape before spending a carrier call on it.
      const problems = validateRisk(risk);
      if (problems.length) {
        throw new ValidationError(
          `Risk failed validation before sending to ${carrier}.`,
          { fields: problems, carrier, requestId },
        );
      }

      const config = { ...(def.config || {}), ...overrides };
      if (!config.baseUrl) {
        throw new QuoteClientError(`No baseUrl configured for carrier ${carrier}.`, { carrier, requestId });
      }

      // 2. Resolve secrets at call time, from the vault, into memory only.
      const secrets = def.secrets ? await secretStore.resolve(def.secrets) : {};

      // 3. Self-throttle before we touch the carrier.
      const waited = await bucketFor(carrier, def.limits).take();
      if (waited) log?.debug('self-throttled', { waitedMs: waited });

      // 4. Authenticate.
      const auth = await authenticate(def, { secrets, config, logger: log, requestId });

      // 5. Build the request from the declarative mapping.
      const q = def.quote || {};
      const mapCtx = { secrets, config, risk, token: auth.token, requestId };

      const path = template(q.path || '/', mapCtx);
      const url = new URL(path.startsWith('http') ? path : `${config.baseUrl}${path}`);

      const declaredQuery = applyMapping(q.query || {}, risk, mapCtx) || {};
      for (const [k, v] of Object.entries({ ...declaredQuery, ...auth.query })) {
        if (v !== undefined && v !== null) url.searchParams.set(k, template(String(v), mapCtx));
      }

      const declaredHeaders = applyMapping(q.headers || {}, risk, mapCtx) || {};
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...Object.fromEntries(Object.entries(declaredHeaders).map(([k, v]) => [k, template(String(v), mapCtx)])),
        ...auth.headers,
      };

      const bodyObj = applyMapping(q.body || ((r) => r), risk, mapCtx);

      // 6. Call.
      const res = await request(url.toString(), {
        method: q.method || 'POST',
        headers,
        body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
        carrier,
        requestId,
        logger: log,
        allowInsecure: config.allowInsecure,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      });

      // 7. Normalise the answer.
      const parsed = typeof def.parse === 'function'
        ? def.parse(res, { risk, requestId, carrier })
        : applyMapping(def.parse || {}, res.json || {}, { res, risk, requestId });

      const out = {
        requestId,
        carrier,
        carrierLabel: def.label || def.id,
        httpStatus: res.status,
        durationMs: res.durationMs,
        ...parsed,
      };

      // A carrier may answer HTTP 200 with the real decision buried in a messages array.
      // Normalising to a required array means downstream code cannot forget to look.
      if (!Array.isArray(out.messages)) out.messages = [];
      if (!out.status) out.status = out.premium ? 'quoted' : 'referred';

      log?.info('quote complete', {
        status: out.status,
        quoteId: out.quoteId,
        premium: out.premium?.annual,
        messageCount: out.messages.length,
        durationMs: res.durationMs,
      });

      return out;
    },
  };
}

module.exports = { defineAdapter, applyMapping, getPath, setPath, template, authenticate };
