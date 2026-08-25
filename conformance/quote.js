#!/usr/bin/env node
'use strict';

/**
 * Demo client - quotes FOUR different kinds of insurance through one contract
 * and prints the four response envelopes side by side. This is the point of
 * EZer in one run: the risk blocks differ per line, the envelope never does.
 *
 * Requires Node 18+. No dependencies, no install step.
 *
 *   # against the bundled reference carrier
 *   node mock-carrier/server.js        # in another terminal
 *   node conformance/quote.js
 *
 *   # against your sandbox (quotes whatever lines you implement; 422s are reported, not fatal)
 *   CARRIER_BASE_URL=https://sandbox.example-carrier.com \
 *   CLIENT_ID=... CLIENT_SECRET=... AGENCY_CODE=... \
 *   node conformance/quote.js
 *
 * Credentials come from the environment, injected at call time from a credential
 * vault. They are never written to source, logs, or disk. See SECURITY.md.
 */

const BASE = (process.env.CARRIER_BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CLIENT_ID = process.env.CLIENT_ID || 'demo_client_a';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'demo_secret_a';
const AGENCY_CODE = process.env.AGENCY_CODE || '1111111';

async function getToken() {
  const res = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      agency_code: AGENCY_CODE,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(`Auth failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

const common = {
  agency: { agencyCode: AGENCY_CODE },
  applicant: { firstName: 'Test', lastName: 'Applicant', dateOfBirth: '1986-11-16' },
};

const RISKS = [
  {
    label: 'HO       homeowners, HO3, Naples FL',
    risk: {
      ...common,
      product: { lineOfBusiness: 'HO', formType: 'HO3', effectiveDate: '2026-10-01', termMonths: 12 },
      property: {
        address: { line1: '1100 5th Ave S', city: 'Naples', state: 'FL', postalCode: '34102' },
        yearBuilt: 2005, constructionType: 'MASONRY', roofYear: 2019,
        occupancy: 'OWNER', usage: 'PRIMARY', distanceToCoastMiles: 2.4, priorClaims: [],
      },
      coverages: { covA: 450000, allOtherPerilsDeductible: 2500, hurricaneDeductible: '2%' },
      mitigation: { openingProtection: 'ALL', secondaryWaterResistance: true },
      creditConsent: true,
    },
  },
  {
    label: 'FLOOD    AE zone, pre-FIRM building',
    risk: {
      ...common,
      product: { lineOfBusiness: 'FLOOD', effectiveDate: '2026-10-01' },
      property: { address: { line1: '1100 5th Ave S', state: 'FL', postalCode: '34102' }, yearBuilt: 1968 },
      coverages: { building: 250000, contents: 50000 },
      flood: { zone: 'AE', elevationCertificate: false },
    },
  },
  {
    label: 'LIFE     30-year term, $500k face',
    risk: {
      ...common,
      product: { lineOfBusiness: 'LIFE', formType: 'TERM', effectiveDate: '2026-10-01', termMonths: 360 },
      coverages: { faceAmount: 500000 },
      life: { sex: 'MALE', tobaccoUse: false, state: 'FL' },
    },
  },
  {
    label: 'COMMERCIAL  BOP, roofing contractor',
    risk: {
      ...common,
      product: { lineOfBusiness: 'COMMERCIAL', formType: 'BOP', effectiveDate: '2026-10-01' },
      business: { name: 'Example Roofing LLC', annualRevenue: 750000, employees: 6, yearsInBusiness: 4 },
      property: { address: { line1: '2 Trade St', state: 'FL', postalCode: '34104' } },
      coverages: { bpp: 50000 },
    },
  },
];

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : String(n);
}

(async () => {
  console.log(`\nQuoting against ${BASE} as agency ${AGENCY_CODE}`);
  console.log('Four kinds of insurance, one contract, one response envelope.\n');

  const token = await getToken();

  for (const { label, risk } of RISKS) {
    const res = await fetch(`${BASE}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId: `demo-${risk.product.lineOfBusiness}-${Date.now()}`, ...risk }),
    });
    const q = await res.json().catch(() => null);

    console.log('-'.repeat(64));
    console.log(`  ${label}`);

    if (!res.ok) {
      // A 422 naming an unimplemented line is an honest answer, not a failure.
      console.log(`  HTTP ${res.status}: ${q?.error_description || q?.error || 'no body'}`);
      continue;
    }

    // Identical handling for every line - this loop body IS the demo.
    console.log(`  quoteId   ${q.quoteId}`);
    console.log(`  status    ${q.status}`);
    if (Array.isArray(q.messages) && q.messages.length) {
      for (const m of q.messages) {
        console.log(`  [${String(m.severity || 'info').toUpperCase()}] ${m.code}: ${m.text}`);
      }
    }
    if (q.premium) {
      console.log(`  premium   ${money(q.premium.annual)} annual, ${money(q.premium.total)} total`);
    } else if (q.status === 'referred') {
      console.log('  premium   pending underwriter review');
    }
  }

  console.log('-'.repeat(64));
  console.log('\nSame status/messages/premium handling for every line. That is the contract.\n');
})().catch((err) => {
  const code = err.cause?.code || '';
  console.error(`\n  ${err.message}${code ? ` (${code})` : ''}`);
  if (code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
    console.error(`  Could not reach ${BASE} - is the mock carrier running? (node mock-carrier/server.js)`);
  }
  console.error('');
  process.exitCode = 1;
});
