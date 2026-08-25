# Changelog

All notable changes to EZer. The format follows [Keep a Changelog](https://keepachangelog.com/);
the spec (`spec/openapi.yaml` `info.version`), the client, and the git tag share one version number.

## [0.1.0] - 2026-08-25

First public release. Early, and honest about it: the contract runs end to end against the
reference carrier, no real carrier has adopted it yet.

### Added

- **The contract**: OpenAPI definition, per-line request/response examples, JSON↔ACORD field
  mapping for the HO line.
- **Eleven lines of business** as a registry — HO (incl. manufactured home MHO3/MDP1), FLOOD,
  AUTO, COMMERCIAL (multistate `locations[]`), TRAVEL, HEALTH (ACA/Medicare/STM/dental/vision),
  LIFE (term/whole/final expense), SURETY, UMBRELLA, RECREATIONAL, HOME_WARRANTY.
  `registerLine()` adds another without forking. HEALTH and LIFE were adversarially reviewed
  before landing; the first drafts were rejected and the published versions carry the fixes.
- **Multistate and international**: no default state anywhere (missing state fails loudly),
  real state-code validation, `country` (ISO 3166-1) makes address rules country-appropriate,
  US-only products refuse non-US explicitly.
- **Reference carrier** rating four lines (HO, flood, life, commercial) through the one response
  envelope, with quoted / referred / declined outcomes all reachable and an honest 422 for
  unimplemented lines.
- **Conformance suite** (25 required checks): auth, agency scoping, envelope shape,
  decline-as-HTTP-200, and multi-line checks that skip — not fail — lines a carrier does not rate.
- **Client**: zero-dependency, carrier-agnostic; adding a carrier is a config object. Two-layer
  secret redaction, vault-backed secrets held in memory only, HTTPS refused-not-warned on
  plaintext, self-throttling, and a hard refusal to start with TLS certificate validation
  disabled. 58 tests.
- CI across Node 18/20/22 on Ubuntu and Windows.

### Known limitations

- Seven of the eleven lines are contract + client validation only; the reference carrier does not
  rate them yet.
- The ACORD field mapping covers the HO line only.
- UL/IUL life products are deliberately excluded until a single canonical premium semantics exists.
