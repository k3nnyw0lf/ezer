# Field mapping — JSON ↔ ACORD personal lines

The JSON contract in this kit is deliberately a thin renaming of the ACORD personal-lines elements
your rating service already consumes.

> **Scope:** this mapping covers the HO (homeowners/dwelling) line, where ACORD personal-lines
> vocabulary applies most directly. Other lines' blocks (flood, life, bond, units, ...) use
> neutral names documented in the OpenAPI spec; mappings for those lines are welcome
> contributions. Agency identifiers below are placeholders. This table exists so your team can recognise the fields
immediately, and so you can tell us "just send ACORD" if that is cheaper for you.

**If you already accept ACORD XML from your rater, we will send ACORD XML.** JSON is offered because
it is usually cheaper for both sides, not because it is required.

## Request

| Kit JSON path | ACORD element (personal lines) | Notes |
|---|---|---|
| `agency.agencyCode` | `ProducerInfo/ContractNumber` | The identifier you already resolve when a rater quotes for us |
| `agency.producerNPN` | `ProducerInfo/NatProducerNumber` | NPN 12345678 |
| `agency.licenseNumber` | `ProducerInfo/LicensedProducerID` | FL AB123456 |
| `product.formType` | `HomeLineBusiness/HomePolicyTypeCd` | HO3 / HO6 / DP3 |
| `product.effectiveDate` | `PersPolicy/ContractTerm/EffectiveDt` | |
| `product.termMonths` | `PersPolicy/ContractTerm/DurationPeriod` | |
| `applicant.firstName` | `GeneralPartyInfo/NameInfo/PersonName/GivenName` | |
| `applicant.lastName` | `GeneralPartyInfo/NameInfo/PersonName/Surname` | |
| `applicant.dateOfBirth` | `PersonInfo/BirthDt` | |
| `applicant.email` | `Communications/EmailInfo/EmailAddr` | |
| `applicant.phone` | `Communications/PhoneInfo/PhoneNumber` | |
| `property.address.line1` | `Addr/Addr1` | |
| `property.address.city` | `Addr/City` | |
| `property.address.state` | `Addr/StateProvCd` | |
| `property.address.postalCode` | `Addr/PostalCode` | |
| `property.address.county` | `Addr/County` | |
| `property.yearBuilt` | `Dwell/Construction/YearBuilt` | |
| `property.constructionType` | `Dwell/Construction/ConstructionCd` | FRAME / MASONRY / MASONRY_VENEER / SUPERIOR / MANUFACTURED |
| `property.roofYear` | `Dwell/Construction/RoofingMaterial/YearBuilt` | |
| `property.roofType` | `Dwell/Construction/RoofingMaterial/RoofMaterialCd` | |
| `property.squareFeet` | `Dwell/Construction/FloorArea/NumUnits` | |
| `property.stories` | `Dwell/Construction/NumStories` | |
| `property.occupancy` | `Dwell/DwellOccupancy/OccupancyTypeCd` | |
| `property.usage` | `Dwell/DwellUse/DwellUseCd` | |
| `property.protectionClass` | `Dwell/DwellFireProtection/ProtectionClassGradeCd` | |
| `property.distanceToCoastMiles` | `Dwell/DwellInspectionValuation/DistanceToCoast` | |
| `property.floodZone` | `Dwell/PropertyInfo/FloodZone` | |
| `property.priorClaims[]` | `Loss/LossDt`, `Loss/LossCauseCd`, `Loss/TotalPaidAmt` | |
| `coverages.covA` … `covF` | `Coverage/CoverageCd` = `DWELL`, `OTHSTRUCT`, `PERSPROP`, `LOSSOFUSE`, `PERSLIAB`, `MEDPM` with `Limit/FormatCurrencyAmt` | |
| `coverages.allOtherPerilsDeductible` | `Deductible[DeductibleTypeCd=AL]/FormatCurrencyAmt` | |
| `coverages.hurricaneDeductible` | `Deductible[DeductibleTypeCd=WIND or HUR]` | Percent or flat |
| `mitigation.*` | `Dwell/PropertyInfo/WindMitigation/*` | FL-specific, materially affects premium |
| `creditConsent` | `PersPolicy/CreditScoreInfo/CreditScoreConsentInd` | |

## Response

| Kit JSON path | ACORD element | Notes |
|---|---|---|
| `quoteId` | `PersPolicy/QuoteInfo/CompanysQuoteNumber` | |
| `status` | *(no single ACORD equivalent)* | See note below |
| `premium.annual` | `PersPolicy/QuoteInfo/EstimatedPremiumAmt` | |
| `premium.total` | `PersPolicy/QuoteInfo/EstimatedTotalPremium` | |
| `payPlans[]` | `PaymentOption/*` | |
| `coverages.*` | `Coverage/*` **as rated**, not as requested | |
| `messages[]` | `MsgStatus/MsgStatusCd`, `MsgErrorCd`, `MsgStatusDesc`, `MsgErrorItem` | |
| `expiresAt` | `PersPolicy/QuoteInfo/QuoteExpirationDt` | |

### On `status`

ACORD's `MsgStatusCd` conflates transport success with underwriting outcome, which is exactly the
ambiguity that has cost us production time. We ask for an explicit `status` of
`quoted` | `referred` | `declined` so the outcome is unambiguous and does not have to be inferred by
parsing message codes.

If you are sending ACORD XML, map it like this and we will handle the rest:

- `MsgStatusCd = Success` **and** a premium present → `quoted`
- `MsgStatusCd = Success` with a referral/underwriting-review message → `referred`
- `MsgStatusCd = Rejected` for an **eligibility** reason → `declined` (still HTTP 200)
- `MsgStatusCd = Error` for a **technical** reason → HTTP 4xx/5xx

The last two lines are the important ones. An ineligible risk and a broken service are different
events and must not arrive looking the same.
