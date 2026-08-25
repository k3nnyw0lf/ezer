'use strict';

const { AuthError } = require('./errors');
const { registerSecret } = require('./redact');

/**
 * Secret provider.
 *
 * Rules this module enforces:
 *   - Secrets are fetched at call time and held in memory only, with a short TTL.
 *   - Nothing is ever written to disk. There is no file-backed provider, on purpose.
 *   - Every secret is registered with the redactor the instant it resolves, so it is scrubbed
 *     from logs even if it later turns up somewhere we did not anticipate.
 *   - A missing secret raises AuthError rather than returning undefined, because an undefined
 *     credential silently becomes the string "undefined" in an Authorization header.
 *
 * Providers:
 *   env       Development only. Reads process.env.
 *   supabase  Production. Calls a SECURITY DEFINER RPC over PostgREST so the secret is decrypted
 *             server side. Confirmed available in this project: get_vault_secret_by_name, and
 *             use_portal_credential which additionally writes an access-log row.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function envProvider() {
  return {
    name: 'env',
    async get(key) {
      const envKey = key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
      return process.env[envKey] ?? null;
    },
  };
}

function supabaseProvider({ url, serviceKey, rpc = 'get_vault_secret_by_name', argName = 'p_name' } = {}) {
  const base = (url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new AuthError('Supabase secret provider needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  registerSecret(key);

  return {
    name: 'supabase',
    async get(secretName) {
      const res = await fetch(`${base}/rest/v1/rpc/${rpc}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: key,
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ [argName]: secretName }),
      });
      if (!res.ok) {
        throw new AuthError(`Vault lookup failed for "${secretName}" (HTTP ${res.status}).`);
      }
      const data = await res.json().catch(() => null);
      if (data === null || data === undefined) return null;
      if (typeof data === 'string') return data;
      if (typeof data === 'object') return data.secret ?? data.value ?? data.decrypted_secret ?? null;
      return null;
    },
  };
}

class SecretStore {
  constructor({ provider, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.provider = provider || envProvider();
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  async get(key, { required = true } = {}) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const value = await this.provider.get(key);
    if (value === null || value === undefined || value === '') {
      this.cache.delete(key);
      if (required) throw new AuthError(`Secret "${key}" not found via ${this.provider.name} provider.`);
      return null;
    }

    registerSecret(value);
    this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  /** Resolve a {alias: secretKey} map into {alias: value}. */
  async resolve(map = {}) {
    const out = {};
    for (const [alias, key] of Object.entries(map)) {
      out[alias] = await this.get(key);
    }
    return out;
  }

  purge() {
    this.cache.clear();
  }
}

module.exports = { SecretStore, envProvider, supabaseProvider, DEFAULT_TTL_MS };
