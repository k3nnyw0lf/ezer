'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { defineAdapter } = require('./core/adapter');
const { SecretStore, envProvider, supabaseProvider } = require('./core/secrets');
const { createLogger } = require('./core/logger');
const { makeRisk, validateRisk, rank, isBindable, actionableMessages } = require('./core/contract');
const redactModule = require('./core/redact');
const errors = require('./core/errors');
const builtIn = require('./adapters');

/**
 * Public entry point.
 *
 *   const client = createClient({ secrets: 'supabase' });
 *   const results = await client.quoteAll(risk);          // every configured carrier, in parallel
 *   const one     = await client.quote('slide', risk);    // a single carrier
 */

function createClient({
  secrets = 'env',
  secretStore,
  logger,
  logLevel,
  adapters,
  carriersDir,
} = {}) {
  const log = logger || createLogger({ level: logLevel });

  let store = secretStore;
  if (!store) {
    const provider = secrets === 'supabase' ? supabaseProvider() : envProvider();
    store = new SecretStore({ provider });
  }

  const registry = new Map();
  const register = (adapter) => {
    if (!adapter || !adapter.id) throw new Error('Cannot register an adapter without an id.');
    registry.set(adapter.id, adapter);
    return adapter;
  };

  // Built-ins, then any private adapters present, then explicit ones.
  for (const a of Object.values(adapters || {})) if (a && a.id && a.quote) register(a);
  if (!adapters) {
    for (const a of [builtIn.ezer, builtIn.sagesure]) register(a);
    const privateDir = path.join(__dirname, 'adapters', 'private');
    if (fs.existsSync(privateDir)) {
      for (const file of fs.readdirSync(privateDir).filter((f) => f.endsWith('.js'))) {
        try {
          const mod = require(path.join(privateDir, file));
          for (const a of Object.values(mod)) if (a && a.id && a.quote) register(a);
        } catch (err) {
          log.warn('failed to load private adapter', { file, error: err.message });
        }
      }
    }
  }

  // Carriers declared purely as JSON config.
  const dir = carriersDir || path.join(__dirname, '..', 'carriers');
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const def = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        register(defineAdapter(def));
      } catch (err) {
        log.warn('failed to load carrier config', { file, error: err.message });
      }
    }
  }

  return {
    logger: log,
    secretStore: store,

    list() {
      return [...registry.values()].map((a) => ({ id: a.id, label: a.label }));
    },

    register,

    async quote(carrierId, risk, opts = {}) {
      const adapter = registry.get(carrierId);
      if (!adapter) throw new errors.QuoteClientError(`No adapter registered for "${carrierId}".`);
      return adapter.quote(risk, { secretStore: store, logger: log, ...opts });
    },

    /**
     * Quote every registered carrier concurrently.
     *
     * A carrier that throws does NOT abort the run - it comes back as an error entry, because a
     * single carrier being down must never cost the agent the other quotes. This is the whole
     * point of quoting programmatically instead of one portal at a time.
     */
    async quoteAll(risk, { only, except, ...opts } = {}) {
      const requestId = opts.requestId || crypto.randomUUID();
      let targets = [...registry.values()];
      if (only) targets = targets.filter((a) => only.includes(a.id));
      if (except) targets = targets.filter((a) => !except.includes(a.id));

      const settled = await Promise.allSettled(
        targets.map((a) => a.quote(risk, { secretStore: store, logger: log, requestId, ...opts })),
      );

      return settled.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        const err = r.reason || {};
        log.error('carrier quote failed', {
          carrier: targets[i].id, requestId, code: err.code, error: err.message,
        });
        return {
          requestId,
          carrier: targets[i].id,
          carrierLabel: targets[i].label,
          status: 'error',
          error: { code: err.code || 'UNKNOWN', message: err.message, retryable: !!err.retryable },
          messages: [],
        };
      });
    },
  };
}

module.exports = {
  createClient,
  defineAdapter,
  makeRisk,
  validateRisk,
  rank,
  isBindable,
  actionableMessages,
  SecretStore,
  envProvider,
  supabaseProvider,
  createLogger,
  adapters: builtIn,
  errors,
  redact: redactModule,
};
