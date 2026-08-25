# Security

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Email **ken@wolfsurety.com** with the details.
You will get a reply within 3 business days; real findings get fixed and credited (unless you
prefer otherwise).

Highest-value targets are the credential path: `client/src/core/redact.js`, `secrets.js`, and
`http.js`. Things worth attacking: getting a secret past `redact()` into a log, making the client
send a credential over plaintext, crashing it badly with a malformed carrier response, or crafting
an adapter config that exfiltrates a secret to an attacker-controlled host.

---

# Agency security posture

**Wolf Insurance · Wolf Surety Inc · FL license W774471 · Agency L115998 · NPN 20187300**

This document answers the questions a carrier's security reviewer asks before issuing an API
credential. It describes how we hold and use carrier credentials today, not aspirations.

## Credential handling

**Credentials live in a dedicated encrypted vault**, not in source control, not in a spreadsheet,
not in email, and not in a chat thread. This is the same vault that already holds the carrier portal
logins we use for the carriers we are appointed with.

- Encrypted at rest, access restricted to the agency principal
- Injected into the process at call time as environment variables, never written to disk
- Never logged. Our client logs request IDs, never headers or bodies containing secrets
- Rotatable on request, by you, at any time, with no notice required

Nothing in this kit contains a real credential. The values in `mock-carrier/server.js` are obvious
demo strings that only work against the bundled mock.

## What the credential can do

We are asking for a credential that is **strictly less privileged** than the one your comparative
rater already holds:

| | Rater partner credential | The credential we are asking for |
|---|---|---|
| Acts on behalf of | Many agencies | One agency, ours |
| Scope | Quote across the book | Quote, our appointment only |
| Bind authority | Varies | **Per policy, authorised by a named licensee, expiring in 15 minutes.** |
| Blast radius if leaked | Every agency on the platform | One agency's quoting |

## No UNATTENDED bind, by design

We are not asking for issuance, endorsement, cancellation, or payment endpoints. We do want to bind,
because quote-only access leaves the agency retyping the entire risk into a portal to put coverage in
force - which is the problem this exists to solve. What we are not asking for is the ability to bind
*without a licensed human doing it*.

An automated quoting bug produces a wrong number on a screen. An automated binding bug produces a
policy that should not exist. So binding is constrained by four controls:

1. **Authorisation expires in 15 minutes.** Every bind carries the timestamp at which a licensed
   producer authorised it. A stored authorisation cannot be replayed by a scheduled job - the
   freshness window is what makes "a human was present" enforceable rather than merely stated.
2. **An idempotency key is required, and binds are never retried.** Our HTTP layer retries transport
   failures, which is correct for a quote and dangerous for a bind: a request that may have succeeded
   must not be replayed. Retries are disabled on the bind path; the idempotency key is the backstop.
3. **Every bind names the licensee.** Licence number and name travel with the request, so the audit
   trail answers "who bound this policy" without reference to server logs.
4. **There is no bulk bind.** Quoting fans out across carriers; binding does not. Ten policies means
   ten authorisations. The absence of the plural is the control.

Honest about the limit: this is a policy and audit control, not cryptographic proof that a human
clicked. A determined caller could forge a fresh timestamp. What it guarantees is that binding cannot
happen by accident, on a schedule, or without a named licensee attached to it.

A carrier that prefers to start quote-only is welcome to. The conformance suite skips the bind checks
entirely when no bind endpoint exists, and reports quote-only as fully conformant.

## Data handling

- **Applicant PII** in a quote request is retained only as long as the quote is live, and is stored
  encrypted in our own systems under the same controls as our agency management data.
- **No resale, no sharing.** Quote data is used to serve the applicant who requested it. We do not
  sell leads and we are not a lead vendor.
- **No scraping.** This kit exists precisely so we do not have to automate against a portal UI. If
  the API request is declined we will continue quoting manually in the portal rather than automate
  the browser.
- Rate limiting is **self-imposed** on our side to whatever ceiling you specify, and we will tell you
  our expected volume in advance. Realistically that is on the order of tens of quotes per month,
  not thousands.

## Transport

- TLS 1.2 minimum, certificate validation always on
- Bearer tokens with a short TTL, refreshed on expiry rather than long-lived static keys
- Every request carries a `requestId` we generate, so any issue we report can be traced in your logs

## Incident handling

If we suspect a credential has been exposed, we will notify your named technical contact and request
rotation immediately, before investigating. We would rather over-report.

## Who we are

Single-location independent agency in Naples, Florida. The agency principal is the person who wrote
this document and who would hold the credential. There is no offshore development team and no
third-party vendor in the path.

**Kenneth Wolf** · Owner & Principal Agent
ken@wolfsurety.com · 888-752-3626 ext 3
