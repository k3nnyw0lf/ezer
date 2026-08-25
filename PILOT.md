# Agency-direct quoting — pilot proposal

**One page. Forward this internally.**

> *Using EZer at your own agency? This is a real, signed proposal rather than a blank template,
> because a worked example is more persuasive than a form. Swap the agency details at the bottom
> for your own and it is ready to send.*

## The proposal

Let one appointed agency call the rating service you already run, using an agency-scoped credential,
for quoting, with binding authorised by a licensed producer. Capped volume. Reversible at any time by
revoking one credential.

## Why this is smaller than it sounds

**This is verified, not assumed.** In our comparative rater's carrier configuration, your entry
holds a login under **our own agency's credential** — our username, our password, our appointment —
with a "save and test" action that validates it against you on demand, and support for per-state
logins.

So the rater does not hold a master key that impersonates us. It holds **our** credential and
presents it to you. Your rating service already:

- receives a per-agency identity on every request
- resolves that identity to an appointment, and to the states, products and forms it may quote
- returns rates specific to that agency's program setup
- meters and logs activity per agency

That is agency-scoped API access. It is in production today. The only thing this pilot changes is
**which process opens the socket** — the agency's own client instead of the rater's.

| Common objection | Reality |
|---|---|
| "We would need to build an API" | The rating service exists. Point us at what the rater calls. |
| "We would need per-agency credentials" | You already issue them. We already hold ours. |
| "We would need entitlement logic" | Already there — it gates what the rater can quote for us today. |
| "We would need per-agency metering" | Already there, or rater reconciliation would not work. |
| "This is a big security change" | The credential is **less** privileged than the rater's: one agency, and binding requires a named licensee per policy. |
| "The rater is a vetted partner, an agency is not" | The rater is presenting **our** credential, not its own. We are asking to present the credential we already hold, ourselves. Nothing new is trusted. |

## What is genuinely new work

Being straight about it, because pretending otherwise wastes your time:

1. **Support model.** Today one partner absorbs tier-1 questions. This puts one agency in direct
   contact with your team. Mitigated by capping the pilot at a single named contact on each side.
2. **A decision to allow it.** Governance, not engineering.

Everything else — schema, auth, entitlements, metering — already exists.

## Scope of the pilot

| | |
|---|---|
| Agencies | 1 (Wolf Insurance) |
| Lines | Homeowners, Florida only |
| Operations | Quote, plus bind **authorised by a licensed producer, one policy at a time**. No endorsement, no payment, no unattended binding. |
| Volume | Tens of quotes per month. We will self-throttle to any ceiling you set. |
| Credential | Agency-scoped, revocable by you at any time, no notice required |
| Schema | **Yours.** We conform to what your rater already receives, ACORD XML included. |
| Duration | 90 days, then a written report either way |
| Cost to you | Issue one credential, share the existing spec, name one contact |

## Why us specifically

- Appointed and actively writing with you now
- Current E&O, single location, principal-run, no offshore dev team
- Already running live carrier quoting APIs in production, so integration questions will be
  competent ones
- Credentials held in an encrypted vault, never in source or email — see `SECURITY.md`
- We have published a working reference implementation and a conformance test suite so your team can
  validate your own endpoint before we ever call it — see `README.md`

## What you get

- A reference integration and a written report your product team can use when scoping this properly
- Evidence for or against agency-direct access, from one low-risk case rather than a guess
- Early positioning. Agency-direct quoting is where this market is going. Doing it once, small and
  controlled, beats doing it later under pressure.

## What we need to start

1. The endpoint your rater already calls, plus a sandbox URL if one exists
2. An agency-scoped API credential
3. The existing integration spec
4. One named technical contact
5. Your rate limit

## Reversibility

Revoke the credential. Everything stops. There is no migration, no customer impact, no contractual
unwind, because nothing is bound through this channel by design.

---

**Kenneth Wolf** · Owner & Principal Agent · Wolf Insurance
ken@wolfsurety.com · 888-752-3626 ext 3
Florida license W774471 · Agency L115998 · NPN 20187300
