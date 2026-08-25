# Contributing to EZer

Thanks for looking. This project is small, practical, and genuinely wants help.

No CLA. No ceremony. Issues and PRs are both fine, and "here is what broke when I tried it" is a
completely valid contribution — arguably the most valuable one.

## Getting started

```bash
git clone <this repo>
cd ezer

node mock-carrier/server.js        # terminal 1
node conformance/quote.js          # terminal 2  - a working quote
node conformance/conformance.js    # terminal 2  - the conformance suite
node client/test/run.js            # the client test suite
```

Node 18 or newer. That is the entire setup.

## The one hard rule: zero dependencies

The client and the tooling have **no npm dependencies**, and that is a feature.

A carrier's security team will not review a dependency tree to run a sample. Zero dependencies means
the whole codebase is auditable in an afternoon and there is no supply chain to compromise.

If you believe something genuinely needs a dependency, open an issue first and make the case. It is
not a closed door — it is a conversation that has to happen before the PR, not after.

## Where help is most wanted

**Real carrier behaviour.** The highest-value contribution is running `conformance.js` against an
actual carrier sandbox and reporting what happened. Every carrier is strange in its own way and this
project has only seen a handful of them.

**ACORD corrections.** `spec/field-mapping.md` was written from working knowledge, not from the
standard documents. If you know ACORD properly, expect to find mistakes, and please fix them.

**Carrier and MGA engineers.** If implementing this contract would be annoying on your side, say so
in an issue. Changing it now is free; changing it after people build against it is not.

**Lines beyond homeowners.** The contract is HO-shaped. Auto, flood, and commercial each deserve a
look from someone who actually writes them.

**Security review of the credential path.** `client/src/core/redact.js`, `secrets.js` and `http.js`
are where a mistake actually costs someone something. Adversarial review welcome — see below.

## Adding a carrier adapter

Most carriers are configuration, not code. Copy `templateAdapter` in
`client/src/adapters/index.js` and fill it in. Checklist:

- [ ] `id` is a stable lowercase slug
- [ ] Secrets are referenced by **vault key name**, never inlined
- [ ] `baseUrl` points at a sandbox by default, never production
- [ ] An ineligible risk maps to `status: 'declined'` and does **not** throw
- [ ] `messages` is always an array, even when empty
- [ ] `limits` set conservatively — self-throttling is polite and keeps access
- [ ] No real agency codes, policy numbers, or names in examples

### Carrier specifications

**Do not commit an adapter built from a carrier's confidential integration document.**

Some carriers share integration specs under NDA or with a reasonable expectation of confidentiality.
Publishing their endpoint shapes, field names, or error codes can breach that and will sour the
relationship for everyone — including the next agency that asks.

`client/src/adapters/private/` is gitignored for exactly this. Adapters there load automatically at
runtime and never get committed. If a carrier has publicly documented their API, it belongs in the
open tree; if they handed you a PDF marked confidential, it does not.

If you are unsure, ask the carrier. They usually answer, and the answer is usually yes.

## Security issues

Please do **not** open a public issue for a vulnerability in the credential-handling path.

Email **ken@wolfsurety.com** with the details. You will get a reply. If it is a real finding it will
be fixed and you will be credited, unless you would rather not be.

Things worth attacking:
- Can you get a secret to survive `redact()` and reach a log?
- Can you make the client send a credential over plaintext?
- Can a malformed carrier response cause the client to leak or crash badly?
- Can an adapter config be crafted to exfiltrate a secret to an attacker-controlled host?

That last one is a known sharp edge: adapter configs are code-adjacent and should be reviewed like
code. If you have a good idea for constraining it without killing the flexibility, that is a
genuinely valuable PR.

## Style

Match the surrounding code. It is plain CommonJS, `'use strict'`, no transpiler, no framework.

Comments should explain **why**, not what. Several comments in this codebase exist because a
specific thing went wrong in production once — those are the most useful comments here, and if you
fix a subtle bug, please leave one behind.

## Tests

`node client/test/run.js` must pass before a PR. Add a test for anything you fix. The runner is
about 40 lines of plain Node at the bottom of that file — no framework to learn.

## Code of conduct

Be decent. Assume good faith. This is a small project run by people with day jobs, so reviews may
take a few days.
