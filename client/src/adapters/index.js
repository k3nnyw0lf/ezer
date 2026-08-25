'use strict';

const { defineAdapter } = require('../core/adapter');

/**
 * Built-in adapters.
 *
 * Everything here is written against a PUBLIC or not-yet-issued specification, so it is safe to
 * publish. Adapters built from a carrier's confidential integration document live in
 * ./private/ which is gitignored - see CONTRIBUTING.md, "Carrier specifications".
 *
 * Each adapter below is deliberately mostly data. If you find yourself writing much logic in one,
 * that is usually a sign the framework is missing a declarative feature - open an issue.
 */

// --------------------------------------------------------------------------
// EZer reference contract
// --------------------------------------------------------------------------

/**
 * Speaks the EZer contract directly: OAuth2-style client credentials scoped to an agency code,
 * then POST /quote. Works against the reference mock carrier, and against any carrier that
 * adopts the contract.
 *
 * This is the adapter to copy when a carrier says "we will build to your spec".
 */
const ezer = defineAdapter({
  id: 'ezer',
  label: 'EZer reference carrier',
  config: {
    baseUrl: process.env.EZER_BASE_URL || 'http://localhost:8787',
    allowInsecure: true, // loopback only; the HTTP layer still refuses non-local plaintext
    timeoutMs: 30_000,
  },
  secrets: {
    clientId: 'ezer/client_id',
    clientSecret: 'ezer/client_secret',
    agencyCode: 'ezer/agency_code',
  },
  auth: {
    kind: 'token_endpoint',
    url: '/auth',
    method: 'POST',
    bodyType: 'json',
    body: {
      grant_type: { const: 'client_credentials' },
      client_id: 'secrets.clientId',
      client_secret: 'secrets.clientSecret',
      agency_code: 'secrets.agencyCode',
    },
    tokenPath: 'access_token',
    applyHeaders: { authorization: 'Bearer {token}' },
  },
  quote: {
    method: 'POST',
    path: '/quote',
    // The canonical risk already IS the EZer contract, so pass it through untouched.
    body: (risk) => risk,
  },
  parse: (res) => {
    const j = res.json || {};
    return {
      quoteId: j.quoteId,
      status: j.status,
      premium: j.premium || null,
      coverages: j.coverages || null,
      payPlans: j.payPlans || [],
      messages: Array.isArray(j.messages) ? j.messages : [],
      expiresAt: j.expiresAt || null,
    };
  },
  limits: { ratePerSecond: 2, burst: 4 },
});

// --------------------------------------------------------------------------
// SageSure
// --------------------------------------------------------------------------

/**
 * SCAFFOLD - not yet functional.
 *
 * SageSure has not issued credentials or documentation. As of 2026-08-25 the request is live with
 * Program Integrations (RC1 scope, Florida homeowners), with a signed questionnaire submitted and
 * business sponsorship pending.
 *
 * Everything below marked TODO must be confirmed against their spec before first use. It is left
 * here so the shape of the work is visible, not because the values are known.
 */
const sagesure = defineAdapter({
  id: 'sagesure',
  label: 'SageSure',
  config: {
    baseUrl: process.env.SAGESURE_BASE_URL || '', // TODO: sandbox host, from SageSure
    timeoutMs: 45_000, // rating engines can be slow; AMTR needed >5s regularly
  },
  secrets: {
    clientId: 'sagesure/client_id',
    clientSecret: 'sagesure/client_secret',
    agencyCode: 'sagesure/agency_code',
  },
  auth: {
    kind: 'token_endpoint',
    url: '/oauth2/token', // TODO confirm
    bodyType: 'form', // TODO confirm: many enterprise carriers use form encoding
    body: {
      grant_type: { const: 'client_credentials' },
      client_id: 'secrets.clientId',
      client_secret: 'secrets.clientSecret',
    },
    tokenPath: 'access_token',
    applyHeaders: { authorization: 'Bearer {token}' },
  },
  quote: {
    method: 'POST',
    path: '/rating/v1/quotes', // TODO confirm
    headers: { 'x-agency-code': '{secrets.agencyCode}' }, // TODO confirm header name
    body: (risk) => risk, // TODO: map to SageSure field names once the spec arrives
  },
  parse: (res) => {
    const j = res.json || {};
    return {
      quoteId: j.quoteNumber ?? j.quoteId,
      status: j.status,
      premium: j.premium ?? null,
      messages: Array.isArray(j.messages) ? j.messages : [],
    };
  },
  limits: { ratePerSecond: 1, burst: 2 },
});

// --------------------------------------------------------------------------
// Template
// --------------------------------------------------------------------------

/**
 * Copy this when adding a carrier. Most carriers need nothing beyond editing these fields.
 * See CONTRIBUTING.md for the checklist.
 */
const templateAdapter = {
  id: 'example',
  label: 'Example Carrier',
  config: { baseUrl: 'https://sandbox.example.com', timeoutMs: 30_000 },
  secrets: { username: 'example/username', password: 'example/password' },
  auth: {
    kind: 'token_endpoint',
    url: '/login',
    body: { user: 'secrets.username', pass: 'secrets.password' },
    tokenPath: 'token',
    applyHeaders: { authorization: 'Bearer {token}' },
  },
  quote: {
    method: 'POST',
    path: '/rate',
    body: {
      // target field           <- canonical risk path
      dwellingLimit: 'coverages.covA',
      yearOfConstruction: 'property.yearBuilt',
      constructionCode: { path: 'property.constructionType', transform: (v) => v.slice(0, 1) },
      zip: 'property.address.postalCode',
      effective: 'product.effectiveDate',
    },
  },
  parse: {
    quoteId: 'QuoteNumber',
    status: { path: 'Decision', transform: (v) => (v === 'OK' ? 'quoted' : 'declined') },
    'premium.annual': 'TotalPremium',
    messages: { path: 'Messages', default: [] },
  },
  limits: { ratePerSecond: 1, burst: 2 },
};

module.exports = { ezer, sagesure, templateAdapter };
