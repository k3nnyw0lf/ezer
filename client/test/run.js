'use strict';

/**
 * Zero-dependency test runner.
 *
 *   node test/run.js
 *
 * Hermetic: spins up its own in-process carrier, so nothing external is required and no real
 * credential is ever involved.
 */

const http = require('node:http');
const assert = require('node:assert');

const redact = require('../src/core/redact');
const { validateRisk, makeRisk, rank, isBindable } = require('../src/core/contract');
const { applyMapping, getPath, template } = require('../src/core/adapter');
const { TokenBucket, resetBuckets } = require('../src/core/ratelimit');
const { request } = require('../src/core/http');
const { createClient, defineAdapter } = require('../src/index');
const { SecretStore } = require('../src/core/secrets');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// redaction - the security-critical surface
// ---------------------------------------------------------------------------

async function redactionTests() {
  console.log('\nredaction');

  await test('a registered secret is scrubbed from a plain string', () => {
    redact.clearRegisteredSecrets();
    redact.registerSecret('sup3r-s3cret-token-value');
    const out = redact.redact('the token is sup3r-s3cret-token-value ok');
    assert.ok(!out.includes('sup3r-s3cret-token-value'), 'secret survived redaction');
    assert.ok(out.includes('[REDACTED]'));
  });

  await test('a registered secret is scrubbed from a nested object', () => {
    redact.clearRegisteredSecrets();
    redact.registerSecret('abc123456789');
    const out = redact.redact({ a: { b: ['x', 'abc123456789'] } });
    assert.strictEqual(out.a.b[1], '[REDACTED]');
  });

  await test('sensitive KEY names are redacted even when the value was never registered', () => {
    redact.clearRegisteredSecrets();
    const out = redact.redact({ password: 'never-registered', client_secret: 'nope', authorization: 'Bearer x' });
    assert.strictEqual(out.password, '[REDACTED]');
    assert.strictEqual(out.client_secret, '[REDACTED]');
    assert.strictEqual(out.authorization, '[REDACTED]');
  });

  await test('PII keys are masked', () => {
    redact.clearRegisteredSecrets();
    const out = redact.redact({ ssn: '111-22-3333', dateOfBirth: '1980-05-14' });
    assert.strictEqual(out.ssn, '[PII]');
    assert.strictEqual(out.dateOfBirth, '[PII]');
  });

  await test('secrets in URL query strings are redacted', () => {
    redact.clearRegisteredSecrets();
    const out = redact.redactUrl('https://c.example.com/q?token=abcdef123456&zip=34102');
    assert.ok(!out.includes('abcdef123456'), 'token survived URL redaction');
    assert.ok(out.includes('zip=34102'), 'non-sensitive query value was destroyed');
  });

  await test('redaction does not mutate the caller object', () => {
    redact.clearRegisteredSecrets();
    const original = { password: 'hunter2' };
    redact.redact(original);
    assert.strictEqual(original.password, 'hunter2');
  });

  await test('bare Bearer tokens in free text are caught even if unregistered', () => {
    redact.clearRegisteredSecrets();
    const out = redact.redact('failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9abcdef'));
  });
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

function goodRisk() {
  return makeRisk({
    product: { formType: 'HO3', effectiveDate: '2026-10-01' },
    applicant: { lastName: 'Applicant' },
    property: {
      address: { line1: '1100 5th Ave S', city: 'Naples', state: 'FL', postalCode: '34102' },
      yearBuilt: 2005,
      constructionType: 'MASONRY',
    },
    coverages: { covA: 450000 },
  });
}

async function contractTests() {
  console.log('\ncontract');

  await test('a complete risk validates', () => {
    assert.deepStrictEqual(validateRisk(goodRisk()), []);
  });

  await test('missing coverage A is caught before any carrier call', () => {
    const r = goodRisk();
    delete r.coverages.covA;
    assert.ok(validateRisk(r).some((p) => p.startsWith('coverages.covA')));
  });

  await test('a bad form type is rejected', () => {
    const r = goodRisk();
    r.product.formType = 'HO99';
    assert.ok(validateRisk(r).some((p) => p.startsWith('product.formType')));
  });

  await test('a malformed ZIP is rejected', () => {
    const r = goodRisk();
    r.property.address.postalCode = '3410';
    assert.ok(validateRisk(r).some((p) => p.startsWith('property.address.postalCode')));
  });

  await test('isBindable is false for a referral carrying a premium', () => {
    assert.strictEqual(isBindable({ status: 'referred', premium: { annual: 100 } }), false);
  });

  await test('rank puts quoted before referred before declined, cheapest first', () => {
    const out = rank([
      { status: 'declined' },
      { status: 'quoted', premium: { annual: 3000 } },
      { status: 'referred', premium: { annual: 10 } },
      { status: 'quoted', premium: { annual: 1200 } },
    ]);
    assert.strictEqual(out[0].premium.annual, 1200);
    assert.strictEqual(out[1].premium.annual, 3000);
    assert.strictEqual(out[2].status, 'referred');
    assert.strictEqual(out[3].status, 'declined');
  });
}

// ---------------------------------------------------------------------------
// lines of business - the "adaptable to any kind of insurance" machinery
// ---------------------------------------------------------------------------

async function lineTests() {
  console.log('\nlines of business');

  const { registerLine } = require('../src/core/contract');

  await test('FLOOD validates with building limit, no covA and no constructionType needed', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'FLOOD', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Applicant' },
      property: { address: { line1: '1 Main St', state: 'FL', postalCode: '34102' }, yearBuilt: 2005 },
      coverages: { building: 250000 },
      flood: { zone: 'AE', elevationCertificate: true },
    });
    assert.deepStrictEqual(validateRisk(r), []);
    assert.strictEqual(r.flood.zone, 'AE');
  });

  await test('FLOOD with neither building nor contents limit is rejected', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'FLOOD', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Applicant' },
      property: { address: { line1: '1 Main St', state: 'FL', postalCode: '34102' }, yearBuilt: 2005 },
    });
    assert.ok(validateRisk(r).some((p) => p.includes('coverages.building or coverages.contents')));
  });

  await test('AUTO validates with a vehicle and driver, and needs no property.yearBuilt', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'AUTO', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Driver' },
      property: { address: { state: 'FL', postalCode: '34109' } },
      vehicles: [{ year: 2022, make: 'Toyota', model: 'Camry', use: 'COMMUTE' }],
      drivers: [{ firstName: 'Test', lastName: 'Driver', dateOfBirth: '1990-01-15' }],
    });
    assert.deepStrictEqual(validateRisk(r), []);
  });

  await test('AUTO with a vehicle missing both vin and year/make/model is rejected', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'AUTO', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Driver' },
      property: { address: { state: 'FL', postalCode: '34109' } },
      vehicles: [{ use: 'COMMUTE' }],
      drivers: [{ lastName: 'Driver', dateOfBirth: '1990-01-15' }],
    });
    assert.ok(validateRisk(r).some((p) => p.includes('vehicles.0')));
  });

  await test('COMMERCIAL BOP validates with business.name instead of applicant.lastName', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'COMMERCIAL', formType: 'BOP', effectiveDate: '2026-10-01' },
      business: { name: 'Example Roofing LLC', classCode: '91340', annualRevenue: 750000, employees: 6 },
      property: { address: { line1: '2 Trade St', state: 'FL', postalCode: '34104' } },
      coverages: { glOccurrence: 1000000, glAggregate: 2000000, bpp: 50000 },
    });
    assert.deepStrictEqual(validateRisk(r), []);
  });

  await test('COMMERCIAL WC without payroll is rejected', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'COMMERCIAL', formType: 'WC', effectiveDate: '2026-10-01' },
      business: { name: 'Example Roofing LLC' },
      property: { address: { state: 'FL' } },
    });
    assert.ok(validateRisk(r).some((p) => p.includes('business.payroll')));
  });

  await test('TRAVEL validates with a trip and travelers', () => {
    const r = makeRisk({
      product: { lineOfBusiness: 'TRAVEL', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Traveler' },
      trip: { startDate: '2026-11-01', endDate: '2026-11-14', destinationCountry: 'ES', tripCost: 4200 },
      travelers: [{ dateOfBirth: '1986-11-16' }],
    });
    assert.deepStrictEqual(validateRisk(r), []);
  });

  await test('an unregistered line is rejected with the list of known lines', () => {
    const r = makeRisk({ product: { effectiveDate: '2026-10-01' }, applicant: { lastName: 'X' } });
    r.product.lineOfBusiness = 'PET';
    const problems = validateRisk(r);
    assert.ok(problems.some((p) => p.includes('not a registered line')));
  });

  await test('registerLine adds a new kind of insurance without forking', () => {
    registerLine('PET', {
      label: 'Pet',
      required: [['pet.species'], ['pet.age', (v) => Number(v) >= 0, 'must be >= 0']],
      skeleton: (p) => ({ pet: { ...(p.pet || {}) } }),
    });
    const r = makeRisk({
      product: { lineOfBusiness: 'PET', effectiveDate: '2026-10-01' },
      applicant: { lastName: 'Owner' },
      pet: { species: 'DOG', age: 4 },
    });
    assert.deepStrictEqual(validateRisk(r), []);
  });

  await test('HO behaviour is unchanged: same defaults, same rejections', () => {
    const r = goodRisk();
    assert.strictEqual(r.product.lineOfBusiness, 'HO');
    assert.strictEqual(r.property.occupancy, 'OWNER');
    delete r.coverages.covA;
    assert.ok(validateRisk(r).some((p) => p.startsWith('coverages.covA')));
  });
}

// ---------------------------------------------------------------------------
// mapping - the "adaptable to any carrier" machinery
// ---------------------------------------------------------------------------

async function mappingTests() {
  console.log('\nmapping');

  const src = { a: { b: { c: 42 } }, list: [{ n: 1 }, { n: 2 }], type: 'MASONRY' };

  await test('dotted paths resolve, including array indexes', () => {
    assert.strictEqual(getPath(src, 'a.b.c'), 42);
    assert.strictEqual(getPath(src, 'list.1.n'), 2);
  });

  await test('string mapping copies from a source path', () => {
    assert.strictEqual(applyMapping('a.b.c', src), 42);
  });

  await test('const, default and transform all work', () => {
    assert.strictEqual(applyMapping({ const: 'HO3' }, src), 'HO3');
    assert.strictEqual(applyMapping({ path: 'missing.x', default: 7 }, src), 7);
    assert.strictEqual(applyMapping({ path: 'type', transform: (v) => v[0] }, src), 'M');
  });

  await test('undefined values are omitted rather than sent as null', () => {
    const out = applyMapping({ keep: 'a.b.c', drop: 'nope.nope' }, src);
    assert.ok('keep' in out);
    assert.ok(!('drop' in out), 'an unresolved field was sent to the carrier');
  });

  await test('nested mappings build nested objects', () => {
    const out = applyMapping({ outer: { inner: 'a.b.c' } }, src);
    assert.strictEqual(out.outer.inner, 42);
  });

  await test('templates substitute from context', () => {
    assert.strictEqual(template('Bearer {token}', { token: 'xyz' }), 'Bearer xyz');
  });
}

// ---------------------------------------------------------------------------
// transport safety
// ---------------------------------------------------------------------------

async function transportTests() {
  console.log('\ntransport safety');

  await test('plaintext HTTP to a non-loopback host is refused', async () => {
    await assert.rejects(
      () => request('http://carrier.example.com/quote', { carrier: 'test', retries: 0 }),
      (err) => /HTTPS is required/.test(err.message),
    );
  });

  await test('loopback plaintext is allowed only with allowInsecure', async () => {
    await assert.rejects(
      () => request('http://localhost:1/x', { carrier: 'test', retries: 0, allowInsecure: false }),
      (err) => /HTTPS is required/.test(err.message),
    );
  });

  await test('token bucket throttles beyond burst', async () => {
    resetBuckets();
    const b = new TokenBucket({ ratePerSecond: 50, burst: 2 });
    assert.strictEqual(await b.take(), 0);
    assert.strictEqual(await b.take(), 0);
    const waited = await b.take();
    assert.ok(waited > 0, 'third call in a burst of 2 should have waited');
  });
}

// ---------------------------------------------------------------------------
// end to end against an in-process carrier
// ---------------------------------------------------------------------------

function startCarrier() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, obj) => {
        const s = JSON.stringify(obj);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(s);
      };
      const parsed = body ? JSON.parse(body) : {};

      if (req.url === '/auth') {
        if (parsed.client_secret !== 'test-secret-value') return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'e2e-token-abcdef123456', expires_in: 3600, agency_code: parsed.agency_code });
      }

      if (req.url.startsWith('/quote')) {
        if (req.headers.authorization !== 'Bearer e2e-token-abcdef123456') {
          return json(401, { error: 'unauthorized' });
        }
        const roofYear = parsed?.property?.roofYear ?? 2020;
        if (roofYear < 1995) {
          return json(200, {
            quoteId: 'Q-DECLINE',
            status: 'declined',
            premium: null,
            messages: [{ severity: 'error', code: 'UW.ROOF.AGE', text: 'Roof too old.' }],
          });
        }
        return json(200, {
          quoteId: 'Q-OK-1',
          status: 'quoted',
          premium: { annual: 1234.56, fees: 25, taxes: 10, total: 1269.56, currency: 'USD' },
          coverages: { covA: parsed?.coverages?.covA },
          payPlans: [],
          messages: [],
        });
      }

      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function e2eTests() {
  console.log('\nend to end');

  const server = await startCarrier();
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const adapter = defineAdapter({
    id: 'e2e',
    label: 'E2E carrier',
    config: { baseUrl, allowInsecure: true, timeoutMs: 5000 },
    secrets: { clientId: 'e2e/client_id', clientSecret: 'e2e/client_secret', agencyCode: 'e2e/agency_code' },
    auth: {
      kind: 'token_endpoint',
      url: '/auth',
      body: {
        grant_type: { const: 'client_credentials' },
        client_id: 'secrets.clientId',
        client_secret: 'secrets.clientSecret',
        agency_code: 'secrets.agencyCode',
      },
      tokenPath: 'access_token',
      applyHeaders: { authorization: 'Bearer {token}' },
    },
    quote: { method: 'POST', path: '/quote', body: (risk) => risk },
    parse: (res) => ({
      quoteId: res.json.quoteId,
      status: res.json.status,
      premium: res.json.premium,
      messages: res.json.messages || [],
    }),
    limits: { ratePerSecond: 100, burst: 100 },
  });

  const store = new SecretStore({
    provider: {
      name: 'test',
      async get(k) {
        return {
          'e2e/client_id': 'test-client',
          'e2e/client_secret': 'test-secret-value',
          'e2e/agency_code': '9990714',
        }[k] ?? null;
      },
    },
  });

  const client = createClient({ secretStore: store, adapters: { e2e: adapter }, logLevel: 'silent' });

  await test('a full auth-then-quote round trip returns a normalised quote', async () => {
    const q = await client.quote('e2e', goodRisk());
    assert.strictEqual(q.status, 'quoted');
    assert.strictEqual(q.quoteId, 'Q-OK-1');
    assert.strictEqual(q.premium.annual, 1234.56);
    assert.ok(Array.isArray(q.messages));
    assert.strictEqual(q.carrier, 'e2e');
  });

  await test('an ineligible risk comes back as status=declined, not as a thrown error', async () => {
    const r = goodRisk();
    r.property.roofYear = 1980;
    const q = await client.quote('e2e', r);
    assert.strictEqual(q.status, 'declined');
    assert.strictEqual(q.messages[0].code, 'UW.ROOF.AGE');
  });

  await test('the carrier token is registered with the redactor automatically', () => {
    const out = redact.redact('leaked e2e-token-abcdef123456 here');
    assert.ok(!out.includes('e2e-token-abcdef123456'), 'carrier token was not auto-registered');
  });

  await test('validation failure never reaches the carrier', async () => {
    const bad = goodRisk();
    delete bad.coverages.covA;
    await assert.rejects(() => client.quote('e2e', bad), (e) => e.code === 'VALIDATION_ERROR');
  });

  await test('quoteAll surfaces a broken carrier as an entry, without losing the good ones', async () => {
    const broken = defineAdapter({
      id: 'broken',
      config: { baseUrl: `http://localhost:${port}`, allowInsecure: true, timeoutMs: 1000, retries: 0 },
      secrets: { clientId: 'e2e/client_id', clientSecret: 'nope/missing', agencyCode: 'e2e/agency_code' },
      auth: { kind: 'token_endpoint', url: '/auth', body: { client_secret: 'secrets.clientSecret' }, tokenPath: 'access_token' },
      quote: { path: '/quote', body: (r) => r },
      parse: (res) => ({ status: res.json?.status }),
    });
    const c2 = createClient({ secretStore: store, adapters: { e2e: adapter, broken }, logLevel: 'silent' });
    const results = await c2.quoteAll(goodRisk());
    assert.strictEqual(results.length, 2);
    assert.ok(results.some((r) => r.status === 'quoted'), 'the healthy carrier was lost');
    assert.ok(results.some((r) => r.status === 'error'), 'the broken carrier was not surfaced');
  });

  server.close();
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('wolf-quote-client test suite');
  await redactionTests();
  await contractTests();
  await lineTests();
  await mappingTests();
  await transportTests();
  await e2eTests();

  console.log('\n' + '-'.repeat(60));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(60) + '\n');
  process.exitCode = failed ? 1 : 0;
})();
