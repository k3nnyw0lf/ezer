# EZer

**An open contract, reference implementation, and client for agency-direct insurance quoting.**

Independent agencies can already quote carriers programmatically — but only by going through a
comparative rater. EZer is an attempt to make the direct path a normal thing that exists.

```bash
node mock-carrier/server.js        # terminal 1
node conformance/quote.js          # terminal 2
```

Node 18+. **No dependencies, no install step, no build.** That is a deliberate security choice, not
a minimalist affectation — see [Why zero dependencies](#why-zero-dependencies).

---

## The problem

If a carrier's rates appear in a comparative rater, that carrier is already running a
machine-readable rating service. The agency's own credentials are usually what the rater presents:
in EZLynx, an agency enters **its own carrier login** per carrier, and the rater quotes **as that
agency**.

So the rating interface exists, it is already multi-tenant, and it already resolves a per-agency
identity to an appointment. What is missing is not technology. It is a channel decision: the
interface was exposed to raters, and never to the agencies themselves.

That means the useful ask is not *"please build an API."* It is:

> **"You already expose rating to a rater using our credential. Let us present that credential
> ourselves."**

EZer exists to make that ask concrete, cheap to evaluate, and safe to say yes to.

## What is here

| Directory | What it is |
|---|---|
| `spec/` | The contract. OpenAPI, request/response examples, and a JSON↔ACORD field mapping so a carrier's team recognises every field. |
| `mock-carrier/` | A working reference carrier. Run it to see the contract behave, or diff it against your own implementation. |
| `conformance/` | **Point it at your sandbox and it tells you whether you conform.** Exit code 0 or 1, so it fits in CI. |
| `client/` | A secure, carrier-agnostic quoting client. Adding a carrier is a config file, not code. |
| `PILOT.md` | A one-page proposal an agency can forward to a carrier. |
| `SECURITY.md` | The posture a carrier's security reviewer will ask about. |

## Three design decisions, each learned the hard way

**1. `status` is authoritative and `messages` is always present.**
A real carrier API returns **HTTP 200 with a valid quote ID** while the actual underwriting decision
sits in a `Messages` array. Checking HTTP status alone silently misses declines. So: `status` is
`quoted | referred | declined`, `messages[]` is required on every response including successes, and
**a decline is HTTP 200**. Reserve 4xx/5xx for transport and auth failures — otherwise a real
outage and a routine decline look identical.

**2. Echo back what you actually rated.**
Carriers adjust Coverage A, deductibles, and roof year during rating. If the agency cannot see the
adjustment, it quotes a client a number the policy will not match.

**3. Credentials are agency-scoped, never partner-scoped.**
A token issued to one agency must not be able to quote as another. The mock enforces this and the
conformance suite tests it. The point: an agency-direct credential is **strictly less privileged**
than the partner credential a rater already holds.

## Why zero dependencies

A carrier's security team will not review an npm dependency tree to run your sample. Neither will
their legal team. Zero dependencies means the entire codebase is auditable in an afternoon, there is
no supply chain to compromise, and `node file.js` is the whole install.

The client keeps this property. If a contribution needs a dependency, that is a discussion, not a
default.

## Security

Credential handling is the part most likely to go wrong, so it is the part with the most tests.

- Secrets are fetched at call time from a vault and held in memory with a short TTL. Nothing is
  written to disk — there is deliberately no file-backed secret provider.
- **Two independent redaction layers.** Registered secret *values* are scrubbed from any output;
  sensitive *key names* are scrubbed regardless of value. The first catches a known secret in an
  unexpected place, the second an unknown secret in an expected place. Real leaks usually need both
  to be missing.
- Carrier tokens are registered with the redactor the instant they are received, before they can
  reach a log or an error message.
- HTTPS is enforced. Plaintext to a non-loopback host is refused outright, not warned about.
- Every request has a hard timeout; retries are exponential with jitter and happen **only** on
  transport failures, 429 and 5xx.
- Self-throttling by default, so nobody discovers a carrier's rate limit by tripping it.

Full posture in [SECURITY.md](SECURITY.md). Run the tests with `node client/test/run.js`.

## Adding a carrier

Most carriers need a config object, not code:

```js
defineAdapter({
  id: 'example',
  config: { baseUrl: 'https://sandbox.example.com' },
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
      dwellingLimit: 'coverages.covA',          // target <- canonical risk path
      yearOfConstruction: 'property.yearBuilt',
      zip: 'property.address.postalCode',
    },
  },
  parse: { quoteId: 'QuoteNumber', 'premium.annual': 'TotalPremium' },
})
```

Every hook also accepts a function, so a genuinely strange carrier never forces a fork.

---

## Help wanted

This started as one small Florida agency trying to stop retyping the same risk into six portals.
It is more useful as a shared thing, and a shared ask is far more likely to move a carrier than a
solo one.

**Especially wanted:**

- **Agency principals and agency devs** — try the conformance suite against any carrier that will
  give you sandbox access, and open an issue with what broke. Real carrier behaviour is the most
  valuable contribution here.
- **ACORD expertise.** The mapping in `spec/field-mapping.md` was written from working knowledge and
  will contain errors. Corrections very welcome.
- **Carrier and MGA engineers.** If this contract would be annoying to implement, say so in an
  issue. It is far cheaper to fix now than after anyone builds against it.
- **Lines beyond homeowners.** The contract is HO-shaped today. Auto, flood, and commercial all
  want a look.
- **Security review.** The redaction and secret-handling code is the part where a mistake actually
  costs someone something. Adversarial review is welcome.

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs both fine; no CLA, no ceremony.

## Status

Early and honest about it. The contract runs end to end against the reference carrier, the client
passes its suite, and no carrier has yet adopted it. That is the point of publishing.

## Licence

MIT. Use it, fork it, ship it in your own stack.
