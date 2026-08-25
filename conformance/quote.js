#!/usr/bin/env node
'use strict';

/**
 * Agency client — the minimal, complete example of how Demo Agency A calls a carrier.
 *
 * Requires Node 18+. No dependencies, no install step.
 *
 *   # against the bundled reference carrier
 *   node mock-carrier/server.js        # in another terminal
 *   node client/quote.js
 *
 *   # against your sandbox
 *   CARRIER_BASE_URL=https://sandbox.example-carrier.com \
 *   CLIENT_ID=... CLIENT_SECRET=... AGENCY_CODE=... \
 *   node client/quote.js
 *
 * Credentials come from the environment, injected at call time from our credential vault.
 * They are never written to source, logs, or disk. See SECURITY.md.
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

async function getQuote(token, risk) {
  const res = await fetch(`${BASE}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(risk),
  });

  const body = await res.json().catch(() => null);

  // Transport and auth failures are the ONLY things that should arrive as non-2xx.
  if (!res.ok) {
    throw new Error(`Quote call failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

const RISK = {
  requestId: `wolf-${Date.now()}`,
  agency: { agencyCode: AGENCY_CODE, producerNPN: '12345678', licenseNumber: 'AB123456' },
  product: { lineOfBusiness: 'HO', formType: 'HO3', effectiveDate: '2026-10-01', termMonths: 12 },
  applicant: {
    firstName: 'Test',
    lastName: 'Applicant',
    dateOfBirth: '1980-05-14',
    email: 'agent@example-agency.com',
    phone: '2395550147',
  },
  property: {
    address: { line1: '1100 5th Ave S', city: 'Naples', state: 'FL', postalCode: '34102', county: 'Collier' },
    yearBuilt: 2005,
    constructionType: 'MASONRY',
    roofYear: 2019,
    roofType: 'ARCHITECTURAL_SHINGLE',
    squareFeet: 2100,
    stories: 1,
    occupancy: 'OWNER',
    usage: 'PRIMARY',
    protectionClass: '3',
    distanceToCoastMiles: 2.4,
    floodZone: 'X',
    priorClaims: [],
  },
  coverages: { covA: 450000, allOtherPerilsDeductible: 2500, hurricaneDeductible: '2%' },
  mitigation: {
    openingProtection: 'ALL',
    roofDeckAttachment: 'B',
    roofWallConnection: 'DOUBLE_WRAPS',
    secondaryWaterResistance: true,
  },
  creditConsent: true,
};

function money(n) {
  return typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : String(n);
}

(async () => {
  console.log(`\nQuoting against ${BASE} as agency ${AGENCY_CODE}\n`);

  const token = await getToken();
  const q = await getQuote(token, RISK);

  console.log(`  quoteId   ${q.quoteId}`);
  console.log(`  status    ${q.status}`);

  // ---------------------------------------------------------------------
  // Read `status` first, and ALWAYS read `messages`. A carrier can return
  // HTTP 200 with a valid quote ID while the real underwriting decision
  // sits in the messages array. We check both, every time.
  // ---------------------------------------------------------------------
  if (Array.isArray(q.messages) && q.messages.length) {
    console.log('\n  Messages:');
    for (const m of q.messages) {
      const field = m.field ? ` (${m.field})` : '';
      console.log(`    [${String(m.severity || 'info').toUpperCase()}] ${m.code}${field}: ${m.text}`);
    }
  }

  if (q.status === 'declined') {
    console.log('\n  DECLINED. Not eligible. Placing this risk elsewhere.\n');
    return;
  }

  if (q.premium) {
    console.log('\n  Premium:');
    console.log(`    annual  ${money(q.premium.annual)}`);
    console.log(`    fees    ${money(q.premium.fees)}`);
    console.log(`    taxes   ${money(q.premium.taxes)}`);
    console.log(`    total   ${money(q.premium.total)}`);
  }

  if (q.coverages) {
    console.log('\n  Coverages as rated by the carrier:');
    for (const [k, v] of Object.entries(q.coverages)) {
      const requested = RISK.coverages[k];
      const changed = requested != null && String(requested) !== String(v);
      console.log(`    ${k.padEnd(28)} ${v}${changed ? `   <- we requested ${requested}` : ''}`);
    }
  }

  if (Array.isArray(q.payPlans) && q.payPlans.length) {
    console.log('\n  Pay plans:');
    for (const p of q.payPlans) {
      console.log(`    ${p.code.padEnd(6)} ${p.description} — down ${money(p.downPayment)}, ${p.installments} x ${money(p.installmentAmount)}`);
    }
  }

  if (q.status === 'referred') {
    console.log('\n  REFERRED. Premium is indicative until an underwriter releases it.');
  }

  console.log('');
})().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exitCode = 1;
});
