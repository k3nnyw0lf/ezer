#!/usr/bin/env node
'use strict';

/**
 * Reference carrier implementation — Demo Agency A agency-direct quoting kit.
 *
 * This is a WORKING example of the contract, not a real rating engine. It exists so a carrier's
 * team can see the intended request/response shapes and auth behaviour by running it, rather than
 * inferring them from a document.
 *
 * Requires Node 18+. No dependencies, no install step.
 *
 *   node mock-carrier/server.js
 *   node mock-carrier/server.js --port 8788
 *
 * The important behaviour to look at:
 *   1. Tokens are scoped to ONE agency code and cannot quote for another (see /quote, 403 branch).
 *   2. Underwriting outcomes are HTTP 200 with status=declined|referred, never 4xx.
 *   3. `messages` is present on every response, including successes.
 *   4. Coverages actually rated are echoed back, adjusted where the carrier overrode them.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : Number(process.env.PORT || 8787);

// Signing key for demo tokens. A real carrier would use its existing IdP.
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_SECONDS = 3600;

/**
 * Credential registry, agency-scoped.
 *
 * NOTE FOR CARRIER REVIEWERS: this mirrors what you already do. Each agency holds its own
 * credential and its own entitlements. Two agencies are defined here specifically so the
 * cross-agency rejection in /quote can be demonstrated.
 */
const AGENCIES = {
  demo_client_a: {
    clientSecret: 'demo_secret_a',
    agencyCode: '1111111',
    agencyName: 'Demo Agency A',
    scope: 'quote:ho',
    states: ['FL'],
    forms: ['HO3', 'HO6', 'DP3'],
  },
  demo_client_b: {
    clientSecret: 'demo_secret_b',
    agencyCode: '2222222',
    agencyName: 'Demo Agency B',
    scope: 'quote:ho',
    states: ['FL'],
    forms: ['HO3'],
  },
};

// ---------------------------------------------------------------------------
// token helpers
// ---------------------------------------------------------------------------

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

function send(res, status, obj) {
  const payload = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJson(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { httpStatus: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function newRequestId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// rating — deterministic, illustrative only
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  ['product.formType', (b) => b?.product?.formType],
  ['product.effectiveDate', (b) => b?.product?.effectiveDate],
  ['applicant.lastName', (b) => b?.applicant?.lastName],
  ['property.address.postalCode', (b) => b?.property?.address?.postalCode],
  ['property.address.state', (b) => b?.property?.address?.state],
  ['property.yearBuilt', (b) => b?.property?.yearBuilt],
  ['property.constructionType', (b) => b?.property?.constructionType],
  ['coverages.covA', (b) => b?.coverages?.covA],
];

function currentYear() {
  return new Date().getUTCFullYear();
}

function rate(body, agency) {
  const messages = [];
  const property = body.property || {};
  const coverages = { ...(body.coverages || {}) };
  const mitigation = body.mitigation || {};

  const covA = Number(coverages.covA) || 0;
  const yearBuilt = Number(property.yearBuilt) || 0;
  const roofYear = Number(property.roofYear) || yearBuilt;
  const roofAge = currentYear() - roofYear;

  // --- eligibility, expressed through `status`, never through HTTP status ---
  if (roofAge > 25) {
    return {
      status: 'declined',
      messages: [{
        severity: 'error',
        code: 'UW.ROOF.AGE',
        text: `Roof age ${roofAge} years exceeds the maximum of 25 for ${body.product.formType}.`,
        field: 'property.roofYear',
      }],
    };
  }

  if (yearBuilt > 0 && yearBuilt < 1960) {
    messages.push({
      severity: 'warning',
      code: 'UW.YEARBUILT.REFERRAL',
      text: `Dwellings built before 1960 require underwriter review. Year built ${yearBuilt}.`,
      field: 'property.yearBuilt',
    });
  }

  if (!Array.isArray(body.forms) && !body.creditConsent) {
    messages.push({
      severity: 'info',
      code: 'RATE.NOCREDIT',
      text: 'Quoted without credit. Premium may improve materially with a credit-consented rerate.',
      field: 'creditConsent',
    });
  }

  // --- carrier-side coverage adjustment, which MUST be echoed back ---
  const minCovA = 150_000;
  if (covA > 0 && covA < minCovA) {
    messages.push({
      severity: 'warning',
      code: 'RATE.COVA.ADJUSTED',
      text: `Coverage A raised from ${covA} to program minimum ${minCovA}.`,
      field: 'coverages.covA',
    });
    coverages.covA = minCovA;
  }

  const ratedCovA = Number(coverages.covA);

  // Derived coverages, if the agency did not supply them.
  if (coverages.covB == null) coverages.covB = Math.round(ratedCovA * 0.02);
  if (coverages.covC == null) coverages.covC = Math.round(ratedCovA * 0.5);
  if (coverages.covD == null) coverages.covD = Math.round(ratedCovA * 0.1);
  if (coverages.covE == null) coverages.covE = 300_000;
  if (coverages.covF == null) coverages.covF = 5_000;
  if (coverages.allOtherPerilsDeductible == null) coverages.allOtherPerilsDeductible = 2_500;
  if (coverages.hurricaneDeductible == null) coverages.hurricaneDeductible = '2%';

  // Deterministic, obviously fake rating maths.
  let premium = ratedCovA * 0.0062;

  const construction = String(property.constructionType || '').toUpperCase();
  if (construction === 'FRAME') premium *= 1.28;
  else if (construction === 'MASONRY') premium *= 0.94;

  premium *= 1 + Math.max(0, roofAge - 10) * 0.018;

  const coast = Number(property.distanceToCoastMiles);
  if (!Number.isNaN(coast) && coast < 1) premium *= 1.35;
  else if (!Number.isNaN(coast) && coast < 5) premium *= 1.15;

  if (mitigation.openingProtection === 'ALL') premium *= 0.86;
  if (mitigation.secondaryWaterResistance === true) premium *= 0.95;

  const claims = Array.isArray(property.priorClaims) ? property.priorClaims.length : 0;
  premium *= 1 + claims * 0.12;

  const annual = Math.round(premium * 100) / 100;
  const fees = 25;
  const taxes = Math.round(annual * 0.0175 * 100) / 100;
  const total = Math.round((annual + fees + taxes) * 100) / 100;

  const status = messages.some((m) => m.code === 'UW.YEARBUILT.REFERRAL') ? 'referred' : 'quoted';

  return {
    status,
    messages,
    coverages,
    premium: { annual, fees, taxes, total, currency: 'USD' },
    payPlans: [
      { code: 'FULL', description: 'Paid in full', downPayment: total, installmentAmount: 0, installments: 0 },
      {
        code: 'MO4',
        description: '4 pay',
        downPayment: Math.round((total * 0.25) * 100) / 100,
        installmentAmount: Math.round((total * 0.25) * 100) / 100,
        installments: 3,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handleAuth(req, res) {
  const body = await readJson(req);
  const { grant_type: grantType, client_id: clientId, client_secret: clientSecret, agency_code: agencyCode } = body;

  if (grantType !== 'client_credentials') {
    return send(res, 400, { error: 'unsupported_grant_type', error_description: 'Use grant_type=client_credentials.' });
  }

  const agency = AGENCIES[clientId];
  const secretOk =
    agency &&
    typeof clientSecret === 'string' &&
    clientSecret.length === agency.clientSecret.length &&
    crypto.timingSafeEqual(Buffer.from(clientSecret), Buffer.from(agency.clientSecret));

  if (!secretOk) {
    return send(res, 401, { error: 'invalid_client', error_description: 'Unknown client_id or client_secret.' });
  }

  // Agency scoping: the credential is bound to one agency code and cannot request another.
  if (agencyCode && agencyCode !== agency.agencyCode) {
    return send(res, 403, {
      error: 'invalid_scope',
      error_description: `This credential is bound to agency ${agency.agencyCode} and cannot request ${agencyCode}.`,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signToken({
    sub: clientId,
    agency_code: agency.agencyCode,
    scope: agency.scope,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });

  return send(res, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: agency.scope,
    agency_code: agency.agencyCode,
  });
}

async function handleQuote(req, res) {
  const token = bearer(req);
  if (!token) {
    return send(res, 401, { error: 'unauthorized', error_description: 'Missing Bearer token.' });
  }

  const claims = verifyToken(token);
  if (!claims) {
    return send(res, 401, { error: 'invalid_token', error_description: 'Token invalid or expired.' });
  }

  const body = await readJson(req);
  const requestId = body.requestId || newRequestId();

  // Agency scoping enforced on the resource, not just at auth.
  const requestedAgency = body?.agency?.agencyCode;
  if (requestedAgency && requestedAgency !== claims.agency_code) {
    return send(res, 403, {
      error: 'forbidden_agency',
      error_description: `Token is scoped to agency ${claims.agency_code}; request specified ${requestedAgency}.`,
      requestId,
    });
  }

  const missing = REQUIRED_FIELDS.filter(([, get]) => {
    const v = get(body);
    return v === undefined || v === null || v === '';
  }).map(([name]) => name);

  if (missing.length) {
    return send(res, 422, {
      error: 'validation_failed',
      error_description: 'Required fields are missing.',
      requestId,
      fields: missing,
    });
  }

  const result = rate(body, claims);
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  // Underwriting outcome is ALWAYS HTTP 200. Read `status`, and always read `messages`.
  return send(res, 200, {
    requestId,
    quoteId: `Q${crypto.randomInt(1_000_000, 9_999_999)}`,
    status: result.status,
    agency: { agencyCode: claims.agency_code },
    carrier: { name: 'Reference Carrier (mock)', naic: '00000' },
    product: {
      formType: body.product.formType,
      effectiveDate: body.product.effectiveDate,
      termMonths: body.product.termMonths || 12,
    },
    premium: result.premium || null,
    payPlans: result.payPlans || [],
    coverages: result.coverages || null,
    messages: result.messages, // required on EVERY response, [] when empty
    expiresAt: result.status === 'declined' ? null : expiresAt,
    documents: [],
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return send(res, 200, { status: 'ok', service: 'reference-carrier-mock' });
    }
    if (req.method === 'POST' && pathname === '/auth') return await handleAuth(req, res);
    if (req.method === 'POST' && pathname === '/quote') return await handleQuote(req, res);

    return send(res, 404, { error: 'not_found', error_description: `No route for ${req.method} ${pathname}.` });
  } catch (err) {
    const status = err.httpStatus || 500;
    return send(res, status, { error: 'request_error', error_description: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Reference carrier listening on http://localhost:${PORT}`);
  console.log('');
  console.log('  Demo credentials (agency-scoped):');
  console.log('    client_id=demo_client_a  client_secret=demo_secret_a  agency_code=1111111');
  console.log('    client_id=demo_client_b client_secret=demo_secret_b agency_code=2222222');
  console.log('');
  console.log('  Try:  node client/quote.js');
  console.log('  Test: node client/conformance.js');
});
