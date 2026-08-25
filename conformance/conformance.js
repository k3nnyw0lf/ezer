#!/usr/bin/env node
'use strict';

/**
 * Conformance tester — point this at YOUR sandbox and it tells you whether the integration
 * behaves the way our client expects.
 *
 * Requires Node 18+. No dependencies, no install step.
 *
 *   # against the bundled reference carrier
 *   node mock-carrier/server.js        # in another terminal
 *   node conformance/conformance.js
 *
 *   # against your sandbox
 *   CARRIER_BASE_URL=https://sandbox.example-carrier.com \
 *   CLIENT_ID=... CLIENT_SECRET=... AGENCY_CODE=... \
 *   node conformance/conformance.js
 *
 * Exit code is 0 when every required check passes, 1 otherwise, so this can sit in CI.
 *
 * Checks marked [REQUIRED] must pass for our client to work correctly against you.
 * Checks marked [ADVISORY] are strong recommendations; failing them is workable but costs us
 * accuracy or costs you support tickets.
 */

const BASE = (process.env.CARRIER_BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CLIENT_ID = process.env.CLIENT_ID || 'demo_client_a';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'demo_secret_a';
const AGENCY_CODE = process.env.AGENCY_CODE || '1111111';
const OTHER_AGENCY_CODE = process.env.OTHER_AGENCY_CODE || '2222222';

const results = [];
let token = null;

function record(name, level, ok, detail) {
  results.push({ name, level, ok, detail });
  const tag = ok ? '  PASS' : (level === 'REQUIRED' ? '  FAIL' : '  WARN');
  console.log(`${tag}  [${level}] ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function call(path, { method = 'POST', body, auth, headers: extraHeaders } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...(extraHeaders || {}) };
  if (auth) headers.authorization = `Bearer ${auth}`;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { networkError: err.message };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave json null, some checks care */
  }
  return { status: res.status, json, text };
}

function sampleQuote(overrides = {}) {
  const base = {
    requestId: `conformance-${Date.now()}`,
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
      address: {
        line1: '1100 5th Ave S',
        city: 'Naples',
        state: 'FL',
        postalCode: '34102',
        county: 'Collier',
      },
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
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a?.[k] === 'object'
      ? deepMerge(a[k], v)
      : v;
  }
  return out;
}

// ---------------------------------------------------------------------------

async function run() {
  console.log(`\nConformance run against ${BASE}\n`);

  // 1 -----------------------------------------------------------------------
  const bad = await call('/auth', {
    body: {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: `${CLIENT_SECRET}_wrong`,
      agency_code: AGENCY_CODE,
    },
  });
  if (bad.networkError) {
    record('Endpoint reachable', 'REQUIRED', false, `Network error: ${bad.networkError}`);
    return finish();
  }
  record(
    'Auth rejects an invalid secret with 401 or 403',
    'REQUIRED',
    bad.status === 401 || bad.status === 403,
    `Got HTTP ${bad.status}.`,
  );

  // 2 -----------------------------------------------------------------------
  const auth = await call('/auth', {
    body: {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      agency_code: AGENCY_CODE,
    },
  });
  const gotToken = auth.status === 200 && auth.json && typeof auth.json.access_token === 'string';
  record(
    'Auth returns an access_token for valid agency credentials',
    'REQUIRED',
    gotToken,
    gotToken ? `expires_in=${auth.json.expires_in}` : `HTTP ${auth.status}: ${(auth.text || '').slice(0, 200)}`,
  );
  if (!gotToken) return finish();
  token = auth.json.access_token;

  record(
    'Auth response echoes the agency_code the token is scoped to',
    'ADVISORY',
    auth.json.agency_code === AGENCY_CODE,
    `Expected ${AGENCY_CODE}, got ${auth.json.agency_code ?? '(absent)'}. Lets us fail fast on a mis-issued credential.`,
  );

  // 3 -----------------------------------------------------------------------
  const noAuth = await call('/quote', { body: sampleQuote() });
  record(
    'Quote without a token is rejected with 401',
    'REQUIRED',
    noAuth.status === 401,
    `Got HTTP ${noAuth.status}.`,
  );

  // 4 -----------------------------------------------------------------------
  const ok = await call('/quote', { body: sampleQuote(), auth: token });
  const quoted = ok.status === 200 && ok.json;
  record(
    'Valid quote request returns HTTP 200',
    'REQUIRED',
    quoted,
    quoted ? '' : `HTTP ${ok.status}: ${(ok.text || '').slice(0, 300)}`,
  );
  if (!quoted) return finish();

  const q = ok.json;

  record(
    'Response carries quoteId and status',
    'REQUIRED',
    typeof q.quoteId === 'string' && typeof q.status === 'string',
    `quoteId=${q.quoteId ?? '(absent)'} status=${q.status ?? '(absent)'}`,
  );

  record(
    'status is one of quoted | referred | declined',
    'REQUIRED',
    ['quoted', 'referred', 'declined'].includes(q.status),
    `Got "${q.status}". This is the single source of truth for the underwriting outcome.`,
  );

  record(
    'messages[] is present on a SUCCESSFUL response',
    'REQUIRED',
    Array.isArray(q.messages),
    Array.isArray(q.messages)
      ? `${q.messages.length} message(s).`
      : 'Absent. We have been bitten by a carrier returning HTTP 200 + a quote ID while the real decision sat in an unread messages array. Send [] when empty.',
  );

  record(
    'Premium is returned as a number, not a formatted string',
    'REQUIRED',
    q.premium && typeof q.premium.annual === 'number',
    q.premium ? `annual=${q.premium.annual} (${typeof q.premium?.annual})` : 'premium absent',
  );

  record(
    'Coverages actually rated are echoed back',
    'REQUIRED',
    q.coverages && q.coverages.covA != null,
    'Without this we cannot tell when you adjusted Coverage A or a deductible, and we would quote a client a number your policy will not match.',
  );

  record(
    'requestId from the request is echoed back',
    'ADVISORY',
    typeof q.requestId === 'string',
    'Makes our bug reports traceable in your logs.',
  );

  record(
    'Pay plans are returned',
    'ADVISORY',
    Array.isArray(q.payPlans),
    'Lets us present down payment and installments without a second call.',
  );

  // 5 -----------------------------------------------------------------------
  const declineCase = await call('/quote', {
    body: sampleQuote({ property: { roofYear: 1985 } }),
    auth: token,
  });
  const declineIsOk = declineCase.status === 200;
  record(
    'An INELIGIBLE risk returns HTTP 200 with status=declined, not a 4xx',
    'REQUIRED',
    declineIsOk && declineCase.json && ['declined', 'referred'].includes(declineCase.json.status),
    declineIsOk
      ? `status=${declineCase.json?.status}`
      : `Got HTTP ${declineCase.status}. Reserve 4xx/5xx for transport and auth failures. An underwriting decline is a successful API call with a negative answer, and conflating them makes real outages indistinguishable from routine declines.`,
  );

  if (declineCase.json && Array.isArray(declineCase.json.messages)) {
    const hasReason = declineCase.json.messages.some((m) => m && m.text);
    record(
      'Decline carries a human-readable reason in messages[]',
      'REQUIRED',
      hasReason,
      hasReason ? '' : 'We surface this reason to the agent so they can fix the risk or place it elsewhere.',
    );
  }

  // 6 -----------------------------------------------------------------------
  const crossAgency = await call('/quote', {
    body: sampleQuote({ agency: { agencyCode: OTHER_AGENCY_CODE } }),
    auth: token,
  });
  record(
    'A token cannot quote on behalf of a DIFFERENT agency code',
    'REQUIRED',
    crossAgency.status === 403 || crossAgency.status === 401,
    crossAgency.status === 403 || crossAgency.status === 401
      ? `Got HTTP ${crossAgency.status}, correctly refused.`
      : `Got HTTP ${crossAgency.status}. Our credential must be strictly LESS privileged than the partner credential your rater holds — scoped to our agency code and nothing else.`,
  );

  // 7 -----------------------------------------------------------------------
  const missing = await call('/quote', {
    body: { requestId: 'conformance-missing', agency: { agencyCode: AGENCY_CODE }, product: {} },
    auth: token,
  });
  record(
    'A malformed request returns 4xx naming the offending fields',
    'ADVISORY',
    missing.status >= 400 && missing.status < 500,
    `Got HTTP ${missing.status}. Field-level errors cut our integration time and your support load.`,
  );

  await multiLineChecks();
  await bindChecks(token, q.quoteId);

  return finish();
}

// ---------------------------------------------------------------------------
// bind - authorised by a licensed human, never by a schedule
// ---------------------------------------------------------------------------

/**
 * These checks are SKIPPED ENTIRELY if the carrier has no /bind endpoint.
 * A quote-only carrier is a perfectly conformant carrier, and failing it for
 * declining to expose binding would be dishonest.
 *
 * Where bind DOES exist, the checks verify one thing: that binding cannot
 * happen without a licensed human, recently, exactly once.
 */
async function bindChecks(token, quoteId) {
  const licensee = {
    licenseNumber: process.env.LICENSE_NUMBER || 'W774471',
    name: process.env.LICENSE_NAME || 'Kenneth Wolf',
    authorizedAt: new Date().toISOString(),
  };
  const key = `conformance-bind-${Date.now()}`;

  const probe = await call('/bind', {
    body: { quoteId, idempotencyKey: key, authorizedBy: licensee },
    auth: token,
    headers: { 'idempotency-key': key },
  });

  if (probe.networkError || probe.status === 404 || probe.status === 405) {
    console.log('\n  ----  bind not offered by this carrier, skipping bind checks  ----');
    console.log('        (quote-only is a valid, conformant implementation)');
    return;
  }

  console.log('');

  record(
    'Bind returns a policy number for a valid, freshly authorised request',
    'REQUIRED',
    probe.status === 200 && probe.json && probe.json.policyNumber,
    probe.status === 200
      ? `policyNumber=${probe.json?.policyNumber} status=${probe.json?.status}`
      : `HTTP ${probe.status}: ${(probe.text || '').slice(0, 250)}`,
  );

  // The control that matters: a stored authorisation must not still work later.
  const stale = {
    ...licensee,
    authorizedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  };
  const staleRes = await call('/bind', {
    body: { quoteId, idempotencyKey: `${key}-stale`, authorizedBy: stale },
    auth: token,
    headers: { 'idempotency-key': `${key}-stale` },
  });
  record(
    'A STALE authorisation is refused - the control against unattended binding',
    'REQUIRED',
    staleRes.status === 403 || staleRes.status === 422,
    staleRes.status === 403 || staleRes.status === 422
      ? `Got HTTP ${staleRes.status}, correctly refused.`
      : `Got HTTP ${staleRes.status}. An authorisation timestamp hours old must not bind. Without a freshness `
        + 'window, a stored authorisation can be replayed by a scheduled job and "a licensed human approved '
        + 'this" stops being true.',
  );

  const noAuth = await call('/bind', {
    body: { quoteId, idempotencyKey: `${key}-noauth` },
    auth: token,
    headers: { 'idempotency-key': `${key}-noauth` },
  });
  record(
    'Bind WITHOUT authorizedBy is refused',
    'REQUIRED',
    noAuth.status >= 400 && noAuth.status < 500,
    noAuth.status >= 400 && noAuth.status < 500
      ? `Got HTTP ${noAuth.status}, correctly refused.`
      : `Got HTTP ${noAuth.status}. Every bind must name the licensee who authorised it.`,
  );

  // Same key twice must not produce a second policy.
  const replay = await call('/bind', {
    body: { quoteId, idempotencyKey: key, authorizedBy: { ...licensee, authorizedAt: new Date().toISOString() } },
    auth: token,
    headers: { 'idempotency-key': key },
  });
  const samePolicy = replay.status === 200
    && replay.json?.policyNumber
    && replay.json.policyNumber === probe.json?.policyNumber;
  record(
    'Replaying the same idempotency key returns the SAME policy, not a second one',
    'REQUIRED',
    samePolicy,
    samePolicy
      ? `Returned ${replay.json.policyNumber} again.`
      : `First bind gave ${probe.json?.policyNumber}, replay gave ${replay.json?.policyNumber}. A network retry `
        + 'on a bind must never issue two policies - this is the one endpoint where a duplicate costs real money.',
  );

  record(
    'Bind response echoes the authorising licensee',
    'ADVISORY',
    probe.json?.authorizedBy?.licenseNumber,
    'Lets the audit trail answer "who bound this policy" without reference to server logs.',
  );
}


// ---------------------------------------------------------------------------
// 8 - multi-line: one envelope for different kinds of insurance
//
// A carrier is NOT required to implement every line. A 422 whose description
// says the line is not implemented is an honest capability answer and records
// as a skip. But any line the carrier DOES rate must speak the same envelope,
// and the referred/declined outcomes must arrive as HTTP 200.
// ---------------------------------------------------------------------------

function lineRisk(lob, overrides = {}) {
  const base = {
    requestId: `conformance-${lob}-${Date.now()}`,
    agency: { agencyCode: AGENCY_CODE },
    applicant: { firstName: 'Test', lastName: 'Applicant', dateOfBirth: '1986-11-16' },
    product: { lineOfBusiness: lob, effectiveDate: '2026-10-01' },
  };
  return deepMerge(base, overrides);
}

const LINE_SAMPLES = [
  {
    lob: 'FLOOD',
    quoted: lineRisk('FLOOD', {
      property: { address: { line1: '1 Main St', state: 'FL', postalCode: '34102' }, yearBuilt: 1990 },
      coverages: { building: 250000, contents: 50000 },
      flood: { zone: 'AE', elevationCertificate: true },
    }),
    outcome: {
      name: 'FLOOD: a V-zone without an elevation certificate is HTTP 200 status=referred',
      risk: lineRisk('FLOOD', {
        property: { address: { line1: '1 Main St', state: 'FL', postalCode: '34102' }, yearBuilt: 2000 },
        coverages: { building: 500000 },
        flood: { zone: 'VE', elevationCertificate: false },
      }),
      expect: ['referred'],
    },
  },
  {
    lob: 'LIFE',
    quoted: lineRisk('LIFE', {
      product: { formType: 'TERM', termMonths: 240 },
      coverages: { faceAmount: 500000 },
      life: { sex: 'MALE', tobaccoUse: false, state: 'FL' },
    }),
    outcome: {
      name: 'LIFE: an age-71 applicant on a 30-year term is HTTP 200 status=declined',
      risk: lineRisk('LIFE', {
        applicant: { lastName: 'Applicant', dateOfBirth: '1955-01-01' },
        product: { formType: 'TERM', termMonths: 360 },
        coverages: { faceAmount: 250000 },
        life: { sex: 'FEMALE', tobaccoUse: false, state: 'FL' },
      }),
      expect: ['declined', 'referred'],
    },
  },
  {
    lob: 'COMMERCIAL',
    quoted: lineRisk('COMMERCIAL', {
      product: { formType: 'BOP' },
      business: { name: 'Example Roofing LLC', annualRevenue: 750000, employees: 6, yearsInBusiness: 4 },
      property: { address: { line1: '2 Trade St', state: 'FL', postalCode: '34104' } },
      coverages: { bpp: 50000 },
    }),
    outcome: null,
  },
];

function isNotImplemented(resp) {
  return resp.status === 422 && /not implemented|does not (rate|support)|rates [A-Z, ]+\./i.test(
    resp.json?.error_description || '',
  );
}

async function multiLineChecks() {
  console.log('\n  --- multi-line (implemented lines must speak the same envelope) ---');

  for (const sample of LINE_SAMPLES) {
    const resp = await call('/quote', { body: sample.quoted, auth: token });

    if (isNotImplemented(resp)) {
      record(
        `${sample.lob}: line implemented`,
        'ADVISORY',
        true,
        'Skipped - carrier answered honestly that it does not rate this line. Not a failure.',
      );
      continue;
    }

    const ok = resp.status === 200 && resp.json;
    record(`${sample.lob}: a valid quote request returns HTTP 200`, 'REQUIRED', !!ok,
      ok ? '' : `HTTP ${resp.status}: ${(resp.text || '').slice(0, 200)}`);
    if (!ok) continue;

    const q = resp.json;
    record(`${sample.lob}: envelope carries quoteId, valid status, messages[]`,
      'REQUIRED',
      typeof q.quoteId === 'string' && ['quoted', 'referred', 'declined'].includes(q.status) && Array.isArray(q.messages),
      `status=${q.status} messages=${Array.isArray(q.messages) ? q.messages.length : 'ABSENT'} - the SAME shape as HO, which is the point of the contract.`);
    if (q.status === 'quoted') {
      record(`${sample.lob}: premium.annual is a number`,
        'REQUIRED', typeof q.premium?.annual === 'number',
        typeof q.premium?.annual === 'number' ? `annual=${q.premium.annual}` : 'premium absent or non-numeric on a quoted response');
    }

    if (sample.outcome) {
      const o = await call('/quote', { body: sample.outcome.risk, auth: token });
      const good = o.status === 200 && sample.outcome.expect.includes(o.json?.status);
      record(sample.outcome.name, 'REQUIRED', good,
        good
          ? `status=${o.json.status}`
          : `Got HTTP ${o.status} status=${o.json?.status}. Underwriting outcomes are HTTP 200 with status + messages, never transport errors.`);
      if (o.status === 200 && o.json && sample.outcome.expect.includes(o.json.status)) {
        record(`${sample.lob}: the ${o.json.status} outcome carries a human-readable reason`,
          'REQUIRED', Array.isArray(o.json.messages) && o.json.messages.some((m) => m && m.text),
          'The agent needs the reason to fix the risk or place it elsewhere.');
      }
    }
  }
}

function finish() {
  const required = results.filter((r) => r.level === 'REQUIRED');
  const failedRequired = required.filter((r) => !r.ok);
  const failedAdvisory = results.filter((r) => r.level === 'ADVISORY' && !r.ok);

  console.log('\n' + '-'.repeat(72));
  console.log(`  ${required.length - failedRequired.length}/${required.length} required checks passed`);
  if (failedAdvisory.length) console.log(`  ${failedAdvisory.length} advisory check(s) worth a look`);

  if (failedRequired.length) {
    console.log('\n  Blocking issues:');
    for (const f of failedRequired) console.log(`    - ${f.name}`);
    const contact = process.env.CONTACT_EMAIL;
    console.log(contact
      ? `\n  Send this output to ${contact} and we will work through it.`
      : '\n  Send this output back to the agency that shared this kit and they will work through it with you.');
    console.log('-'.repeat(72) + '\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n  All required checks passed. We can build against this today.');
  console.log('-'.repeat(72) + '\n');
  process.exitCode = 0;
}

run().catch((err) => {
  console.error('\nConformance runner crashed:', err.message);
  process.exitCode = 1;
});
