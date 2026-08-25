'use strict';

/**
 * The canonical risk and quote shapes - multi-line.
 *
 * Everything in this client speaks these shapes. Carrier-specific vocabulary lives only in
 * adapter definitions, and LINE-specific requirements live only in the registry below - so
 * adding a carrier is an adapter config, and adding a line of business is a line definition.
 *
 * product.lineOfBusiness is the discriminator: HO, FLOOD, AUTO, COMMERCIAL, TRAVEL out of the
 * box, and registerLine() adds more without forking. Validation is line-aware; the response
 * shape (status/messages/premium/coverages) is deliberately identical across every line.
 */

const STATUSES = ['quoted', 'referred', 'declined'];

// Kept for backward compatibility with existing HO callers and adapters.
// MHO3/MDP1 are the manufactured-home forms (Citizens vocabulary) - MH rides on
// the HO line rather than being its own, since the risk shape is identical.
const FORM_TYPES = ['HO3', 'HO4', 'HO6', 'DP1', 'DP3', 'MHO3', 'MDP1'];
const CONSTRUCTION = ['FRAME', 'MASONRY', 'MASONRY_VENEER', 'SUPERIOR', 'MANUFACTURED'];

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function get(obj, path) {
  return String(path).split('.').reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), obj);
}

function present(v) {
  return v !== undefined && v !== null && v !== '';
}

const IS_DATE = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
// All 50 states + DC + the territories where these lines are actually sold.
// "Any two capital letters" would validate XX and quietly break multistate routing.
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO '
  + 'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP').split(' '));
const IS_STATE = (v) => US_STATES.has(String(v));
const IS_ZIP = (v) => /^\d{5}(-\d{4})?$/.test(String(v));
// ISO 3166-1 alpha-2. risk.country defaults to US; any other assigned code makes
// the address rules country-appropriate instead of forcing ZIPs on the world.
const ISO_COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  + 'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
  + 'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ '
  + 'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ '
  + 'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const IS_COUNTRY = (v) => ISO_COUNTRIES.has(String(v));
const countryOf = (risk) => String(risk.country || 'US').toUpperCase();

/**
 * Country-aware address validation. US addresses keep exact state/ZIP rules;
 * everywhere else, postal codes follow local formats (validated for sanity,
 * not shape) and state/region is optional. Message paths stay identical to
 * the US-only era so existing callers' error handling does not change.
 */
function addressProblems(risk, base, opts = {}) {
  const problems = [];
  const addr = get(risk, base) || {};
  if (opts.line1 && !present(addr.line1)) problems.push(base + '.line1 is required');
  if (countryOf(risk) === 'US') {
    if (!present(addr.state)) problems.push(base + '.state is required');
    else if (!IS_STATE(addr.state)) problems.push(base + '.state must be a valid US state/territory code');
    if (!present(addr.postalCode)) problems.push(base + '.postalCode is required');
    else if (!IS_ZIP(addr.postalCode)) problems.push(base + '.postalCode must be a US ZIP');
  } else {
    if (!present(addr.postalCode)) problems.push(base + '.postalCode is required');
    else if (String(addr.postalCode).length > 10) problems.push(base + '.postalCode must be 10 characters or fewer');
    if (present(addr.state) && !/^[A-Za-z0-9]{1,3}$/.test(String(addr.state))) {
      problems.push(base + '.state must be a 1-3 character region code outside the US');
    }
  }
  return problems;
}

/** For scalar state fields (rating/filing jurisdiction). Required in every country. */
function stateOrRegionProblem(risk, path, label) {
  const v = get(risk, path);
  const suffix = label ? ' (' + label + ')' : '';
  if (countryOf(risk) === 'US') {
    return IS_STATE(v) ? null : path + ' must be a valid US state/territory code' + suffix;
  }
  return present(v) && /^[A-Za-z0-9]{1,3}$/.test(String(v)) ? null
    : path + ' must be a 1-3 character region code' + suffix;
}
const IS_POSITIVE = (v) => Number(v) > 0;
const IS_YEAR = (v) => Number(v) > 1800 && Number(v) <= new Date().getUTCFullYear() + 1;

// --------------------------------------------------------------------------
// line-of-business registry
// --------------------------------------------------------------------------

/**
 * A line definition:
 *   label      human name
 *   formTypes  allowed product.formType values, or null for free-form
 *   required   [ [path, test, message] ] - test/message optional
 *   validate   (risk) => string[]        - extra cross-field rules
 *   skeleton   (partial) => object       - line-specific blocks for makeRisk
 */
const LINES = {};

function registerLine(code, def) {
  if (!code || typeof code !== 'string') throw new Error('registerLine needs a line code.');
  LINES[code.toUpperCase()] = { label: code, formTypes: null, required: [], skeleton: () => ({}), ...def };
  return LINES[code.toUpperCase()];
}

// ---- Homeowners / dwelling fire (the original shape, unchanged) ----------
registerLine('HO', {
  label: 'Homeowners / Dwelling Fire',
  formTypes: FORM_TYPES,
  required: [
    ['applicant.lastName'],
    ['property.yearBuilt', IS_YEAR, 'is out of range'],
    ['property.constructionType', (v) => CONSTRUCTION.includes(v), `must be one of ${CONSTRUCTION.join(', ')}`],
    ['coverages.covA', IS_POSITIVE, 'must be a positive number'],
  ],
  validate: (risk) => addressProblems(risk, 'property.address', { line1: true }),
  skeleton: (p) => ({
    property: {
      occupancy: 'OWNER',
      usage: 'PRIMARY',
      priorClaims: [],
      ...(p.property || {}),
      address: { ...((p.property || {}).address || {}) },
    },
  }),
});

// ---- Flood (NFIP + private: Neptune, Wright, Floodsol shapes) ------------
registerLine('FLOOD', {
  label: 'Flood',
  formTypes: null,
  required: [
    ['applicant.lastName'],
    ['property.yearBuilt', IS_YEAR, 'is out of range'],
  ],
  validate: (risk) => {
    const problems = addressProblems(risk, 'property.address', { line1: true });
    if (!present(get(risk, 'coverages.building')) && !present(get(risk, 'coverages.contents'))) {
      problems.push('coverages.building or coverages.contents is required for FLOOD');
    }
    return problems;
  },
  skeleton: (p) => ({
    property: {
      occupancy: 'OWNER',
      usage: 'PRIMARY',
      ...(p.property || {}),
      address: { ...((p.property || {}).address || {}) },
    },
    // Flood-specific facts private carriers actually rate on. All optional.
    // { zone, elevationCertificate, lowestFloorElevationFeet, baseFloodElevationFeet,
    //   foundationType, floorsAboveGround, enclosure, priorNfipPolicy, cbrsZone }
    flood: { ...(p.flood || {}) },
  }),
});

// ---- Personal auto -------------------------------------------------------
registerLine('AUTO', {
  label: 'Personal Auto',
  formTypes: null,
  required: [],
  validate: (risk) => {
    const problems = addressProblems(risk, 'property.address'); // garaging address
    const vehicles = risk.vehicles || [];
    const drivers = risk.drivers || [];
    if (!vehicles.length) problems.push('vehicles must contain at least one vehicle');
    vehicles.forEach((v, i) => {
      if (!present(v.vin) && !(present(v.year) && present(v.make) && present(v.model))) {
        problems.push(`vehicles.${i} needs a vin, or year + make + model`);
      }
    });
    if (!drivers.length) problems.push('drivers must contain at least one driver');
    drivers.forEach((d, i) => {
      if (!present(d.lastName)) problems.push(`drivers.${i}.lastName is required`);
      if (!present(d.dateOfBirth) && !present(d.licenseNumber)) {
        problems.push(`drivers.${i} needs dateOfBirth or licenseNumber`);
      }
    });
    return problems;
  },
  skeleton: (p) => ({
    property: { ...(p.property || {}), address: { ...((p.property || {}).address || {}) } },
    // [{ vin | year+make+model, use: 'COMMUTE', annualMiles, comprehensiveDeductible, collisionDeductible }]
    vehicles: [...(p.vehicles || [])],
    // [{ firstName, lastName, dateOfBirth, licenseNumber, licenseState, incidents: [] }]
    drivers: [...(p.drivers || [])],
  }),
});

// ---- Commercial (BOP / GL / WC / commercial property) --------------------
registerLine('COMMERCIAL', {
  label: 'Commercial',
  formTypes: null, // BOP, GL, WC, PROP, CYBER, ... carrier vocabularies differ too much to enumerate
  required: [
    ['product.formType', undefined, 'is required (e.g. BOP, GL, WC)'],
    ['business.name'],
  ],
  validate: (risk) => {
    const problems = [];
    const premisesProblem = stateOrRegionProblem(risk, 'property.address.state', 'primary premises');
    if (premisesProblem) problems.push(premisesProblem);
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    if (ft === 'WC' && !present(get(risk, 'business.payroll'))) {
      problems.push('business.payroll is required for WC');
    }
    if ((ft === 'BOP' || ft === 'PROP') && !present(get(risk, 'property.address.line1'))) {
      problems.push('property.address.line1 is required for premises-based forms');
    }
    // Multistate / multi-country: additional premises beyond property.address.
    (risk.locations || []).forEach((loc, i) => {
      const st = get(loc, 'address.state');
      const ok = countryOf(risk) === 'US' ? IS_STATE(st) : (present(st) && /^[A-Za-z0-9]{1,3}$/.test(String(st)));
      if (!ok) problems.push(`locations.${i}.address.state must be a valid state/region code`);
    });
    return problems;
  },
  skeleton: (p) => ({
    property: { ...(p.property || {}), address: { ...((p.property || {}).address || {}) } },
    // Multistate premises: [{ address, payroll, employees, bpp }] - WC payroll and
    // BOP property split by state/location live here; property.address is the primary.
    locations: [...(p.locations || [])],
    // What commercial carriers actually rate on. classCode is the carrier's or NAICS.
    business: {
      // name, dba, fein, entityType, description, classCode, naics,
      // yearsInBusiness, annualRevenue, employees, payroll, website
      ...(p.business || {}),
    },
  }),
});

// ---- Travel --------------------------------------------------------------
registerLine('TRAVEL', {
  label: 'Travel',
  formTypes: null,
  required: [
    ['trip.startDate', IS_DATE, 'must be YYYY-MM-DD'],
    ['trip.endDate', IS_DATE, 'must be YYYY-MM-DD'],
  ],
  validate: (risk) => {
    const problems = [];
    if (present(get(risk, 'trip.destinationCountry')) && !IS_COUNTRY(get(risk, 'trip.destinationCountry'))) {
      problems.push('trip.destinationCountry must be an ISO 3166-1 alpha-2 code');
    }
    const travelers = risk.travelers || [];
    if (!travelers.length) problems.push('travelers must contain at least one traveler');
    travelers.forEach((t, i) => {
      if (!present(t.dateOfBirth) && !present(t.age)) problems.push(`travelers.${i} needs dateOfBirth or age`);
    });
    return problems;
  },
  skeleton: (p) => ({
    // { startDate, endDate, destinationCountry, tripCost, initialDepositDate }
    trip: { ...(p.trip || {}) },
    travelers: [...(p.travelers || [])],
  }),
});

// ---- Health (ACA / Medicare / STM / dental / vision) ---------------------
// Designed against the author's LIVE HealthSherpa integration, then adversarially
// reviewed. Two review findings shaped it: (1) a health request can match many
// filed plans, so coverages.planId (HIOS/CMS contract-plan id) optionally pins ONE;
// absent planId, engines MUST return their lowest-premium qualifying plan and say
// so in messages - otherwise two implementations return incomparable numbers.
// (2) county FIPS is how both ACA and Medicare actually rate, but requiring it
// taxes every adopter with a ZIP-to-FIPS lookup; it is optional, and engines
// refuse ambiguous ZIPs with a message rather than a schema error.
const HEALTH_FORMS = ['ACA', 'MEDICARE_ADVANTAGE', 'MEDIGAP', 'PDP', 'STM', 'DENTAL', 'VISION'];
const MEDICARE_FORMS = ['MEDICARE_ADVANTAGE', 'MEDIGAP', 'PDP'];
const FIRST_OF_MONTH_FORMS = ['ACA', 'MEDICARE_ADVANTAGE', 'PDP'];

registerLine('HEALTH', {
  label: 'Health',
  formTypes: HEALTH_FORMS,
  required: [
    ['location.zip', IS_ZIP, 'must be a US ZIP'],
  ],
  validate: (risk) => {
    const problems = [];
    // ACA, Medicare, STM, and US dental/vision networks are US products by law.
    if (countryOf(risk) !== 'US') {
      problems.push('HEALTH formTypes are US-only products - country must be US or omitted');
    }
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    const members = risk.members || [];

    if (!members.length) problems.push('members must contain at least one entry');
    members.forEach((m, i) => {
      if (!['PRIMARY', 'SPOUSE', 'DEPENDENT'].includes(m.relationship)) {
        problems.push(`members.${i}.relationship must be PRIMARY, SPOUSE or DEPENDENT`);
      }
      if (!IS_DATE(m.dateOfBirth) || new Date(m.dateOfBirth) >= new Date()) {
        problems.push(`members.${i}.dateOfBirth must be YYYY-MM-DD in the past`);
      }
      if (m.tobaccoUse !== undefined && typeof m.tobaccoUse !== 'boolean') {
        problems.push(`members.${i}.tobaccoUse must be a boolean`);
      }
      if ((ft === 'ACA' || ft === 'STM') && typeof m.tobaccoUse !== 'boolean') {
        problems.push(`members.${i}.tobaccoUse is required for ${ft}`);
      }
      if (m.gender !== undefined && !['MALE', 'FEMALE', 'UNSPECIFIED'].includes(m.gender)) {
        problems.push(`members.${i}.gender must be MALE, FEMALE or UNSPECIFIED`);
      }
      if (m.label !== undefined && String(m.label).length > 40) {
        problems.push(`members.${i}.label must be 40 chars or fewer (display-only, never an identity)`);
      }
    });
    if (members.filter((m) => m.relationship === 'PRIMARY').length !== 1) {
      problems.push('members must contain exactly one PRIMARY');
    }
    if (members.filter((m) => m.relationship === 'SPOUSE').length > 1) {
      problems.push('members must contain at most one SPOUSE');
    }
    if (MEDICARE_FORMS.includes(ft) && members.length !== 1) {
      problems.push(`${ft} rates one life - members must contain exactly one entry`);
    }

    if (present(get(risk, 'location.countyFips')) && !/^\d{5}$/.test(String(get(risk, 'location.countyFips')))) {
      problems.push('location.countyFips must be a 5-digit county FIPS code');
    }

    const hh = risk.household;
    if (hh && Object.keys(hh).length) {
      if (ft !== 'ACA') problems.push('household (subsidy inputs) is only valid for ACA');
      if (!IS_POSITIVE(hh.income)) problems.push('household.income is required when household is present');
      if (!(Number.isInteger(hh.size) && hh.size >= 1)) problems.push('household.size is required when household is present');
      if (Number.isInteger(hh.size) && hh.size < members.length) {
        problems.push('household.size must be >= the number of members');
      }
    }

    if (ft === 'MEDIGAP' && !present(get(risk, 'coverages.planLetter'))) {
      problems.push('coverages.planLetter is required for MEDIGAP');
    }
    if (ft !== 'MEDIGAP' && present(get(risk, 'coverages.planLetter'))) {
      problems.push('coverages.planLetter is only valid for MEDIGAP');
    }
    if (ft !== 'ACA' && present(get(risk, 'coverages.metalTier'))) {
      problems.push('coverages.metalTier is only valid for ACA');
    }

    if (ft === 'STM') {
      const tm = get(risk, 'product.termMonths');
      if (!(Number.isInteger(tm) && tm >= 1 && tm <= 12)) {
        problems.push('product.termMonths (1-12) is required for STM');
      }
    }
    const eff = get(risk, 'product.effectiveDate');
    if (FIRST_OF_MONTH_FORMS.includes(ft) && IS_DATE(eff) && !/-01$/.test(eff)) {
      problems.push(`product.effectiveDate must be the first of a month for ${ft}`);
    }
    return problems;
  },
  skeleton: (p) => ({
    // Health rates by county, not street address - no property block.
    location: { ...(p.location || {}) },
    // The rated lives. Identified by relationship + DOB + optional display label,
    // never by name - dependent names are not needed to price a plan.
    members: [...(p.members || [])],
    // ACA subsidy switch: present = subsidy-estimated quote, absent = full price.
    household: { ...(p.household || {}) },
  }),
});

// ---- Life (term / whole / final expense) ---------------------------------
// Adversarially reviewed. UL/IUL are deliberately CUT from v1: "target or minimum
// premium, engine's choice" makes cross-carrier comparison meaningless, and the
// shared response schema has no field to say which basis was used. They return
// when a single canonical premium semantics is settled.
registerLine('LIFE', {
  label: 'Life',
  formTypes: ['TERM', 'WHOLE', 'FINAL_EXPENSE'],
  required: [
    ['applicant.dateOfBirth', IS_DATE, 'must be YYYY-MM-DD'],
    ['coverages.faceAmount', (v) => Number.isInteger(v) && v >= 1000, 'must be a whole-dollar integer >= 1000'],
    ['life.sex', (v) => ['MALE', 'FEMALE'].includes(v), 'must be MALE or FEMALE (as rated by mortality tables; unisex states handled engine-side)'],
    ['life.tobaccoUse', (v) => typeof v === 'boolean', 'must be a boolean'],
  ],
  validate: (risk) => {
    const problems = [];
    const stProblem = stateOrRegionProblem(risk, 'life.state', 'rating/issue jurisdiction');
    if (stProblem) problems.push(stProblem);
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    const eff = get(risk, 'product.effectiveDate');
    const dob = get(risk, 'applicant.dateOfBirth');

    if (IS_DATE(dob) && IS_DATE(eff) && new Date(dob) >= new Date(eff)) {
      problems.push('applicant.dateOfBirth must precede product.effectiveDate');
    }

    // Term length: any positive multiple of 12 - NOT a closed enum. 35- and
    // 40-year terms are mainstream since ~2021; "term not offered" is a carrier
    // decline message, never a schema error. Common bands: 120/180/240/300/360.
    if (ft === 'TERM') {
      const tm = get(risk, 'product.termMonths');
      if (!(Number.isInteger(tm) && tm > 0 && tm % 12 === 0)) {
        problems.push('product.termMonths is required for TERM and must be a positive multiple of 12');
      }
    }
    // termMonths sent on WHOLE/FINAL_EXPENSE is ignored (permanent coverage), not an error.

    const life = risk.life || {};

    // Tobacco: the DATE is authoritative over the boolean. Within 12 months of
    // the effective date <=> tobaccoUse must be true; older than 12 months, the
    // boolean must be false (former-user banding is the engine's job).
    if (present(life.tobaccoLastUseDate)) {
      if (!IS_DATE(life.tobaccoLastUseDate)) {
        problems.push('life.tobaccoLastUseDate must be YYYY-MM-DD');
      } else if (IS_DATE(eff)) {
        const last = new Date(life.tobaccoLastUseDate);
        const effD = new Date(eff);
        if (last > effD) problems.push('life.tobaccoLastUseDate cannot be after product.effectiveDate');
        else {
          const within12mo = (effD - last) <= 366 * 24 * 3600 * 1000;
          if (within12mo && life.tobaccoUse !== true) {
            problems.push('life.tobaccoUse must be true when tobaccoLastUseDate is within 12 months of the effective date');
          }
          if (!within12mo && life.tobaccoUse === true) {
            problems.push('life.tobaccoUse must be false when tobaccoLastUseDate is more than 12 months before the effective date');
          }
        }
      }
    }

    // Build: both-or-neither, with sanity bounds. Build wins over healthClass.
    const hasH = present(life.heightInches);
    const hasW = present(life.weightPounds);
    if (hasH !== hasW) problems.push('life.heightInches and life.weightPounds must be given together');
    if (hasH && !(Number(life.heightInches) >= 12 && Number(life.heightInches) <= 96)) {
      problems.push('life.heightInches must be between 12 and 96');
    }
    if (hasW && !(Number(life.weightPounds) >= 30 && Number(life.weightPounds) <= 1200)) {
      problems.push('life.weightPounds must be between 30 and 1200');
    }
    if (present(life.healthClass) && !['PREFERRED_PLUS', 'PREFERRED', 'STANDARD_PLUS', 'STANDARD', 'SUBSTANDARD'].includes(life.healthClass)) {
      problems.push('life.healthClass must be PREFERRED_PLUS, PREFERRED, STANDARD_PLUS, STANDARD or SUBSTANDARD');
    }

    // Riders live in the universal endorsements block, keyed camelCase.
    if (present(get(risk, 'endorsements.returnOfPremium')) && ft !== 'TERM') {
      problems.push('endorsements.returnOfPremium is only valid for TERM');
    }
    return problems;
  },
  skeleton: (p) => ({
    // sex, tobaccoUse, tobaccoLastUseDate, state, healthClass, heightInches,
    // weightPounds. No beneficiary identity, no SSN, no medical records - a
    // quote needs none of them.
    life: { ...(p.life || {}) },
  }),
});

// ---- Surety (bonds - license/permit, contract, court, fidelity) ----------
// Adversarially reviewed. The reviewer's key correction: a surety soft credit
// pull runs on the OWNER'S personal identity, so creditConsent=true demands the
// indemnitor's personal address + DOB even when the principal is an entity.
// bondType is an open registry slug (thousands of forms are filed per state);
// engines reject slugs unknown for the state, the contract does not freeze them.
registerLine('SURETY', {
  label: 'Surety',
  formTypes: ['LICENSE_PERMIT', 'BID', 'PERFORMANCE', 'PAYMENT', 'COURT', 'FIDELITY'],
  required: [
    ['bond.bondType', undefined, 'is required (registry slug, e.g. contractorLicense, notaryPublic, appeal)'],
  ],
  validate: (risk) => {
    const problems = [];
    const stProblem = stateOrRegionProblem(risk, 'bond.state', 'filing jurisdiction');
    if (stProblem) problems.push(stProblem);
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    const bond = risk.bond || {};

    // Penal sum: required, except BID may derive it from percent x contract.
    const hasAmount = IS_POSITIVE(bond.bondAmount);
    const bidDerivable = ft === 'BID' && IS_POSITIVE(bond.contractAmount)
      && Number(bond.bidBondPercent) > 0 && Number(bond.bidBondPercent) <= 100;
    if (!hasAmount && !bidDerivable) {
      problems.push('bond.bondAmount is required (BID may instead send contractAmount + bidBondPercent)');
    }

    if (['BID', 'PERFORMANCE', 'PAYMENT'].includes(ft)) {
      if (!IS_POSITIVE(bond.contractAmount)) problems.push(`bond.contractAmount is required for ${ft}`);
      if (!present(bond.projectDescription)) problems.push(`bond.projectDescription is required for ${ft}`);
      if (!present(get(bond, 'obligee.name'))) problems.push(`bond.obligee.name (the project owner) is required for ${ft}`);
    }
    if (ft === 'COURT' && !present(get(bond, 'obligee.name'))) {
      problems.push('bond.obligee.name (the court) is required for COURT');
    }
    // ERISA fidelity prices purely on penal sum - employeeCount only for the rest.
    if (ft === 'FIDELITY' && String(bond.bondType).toLowerCase() !== 'erisa'
      && !(Number.isInteger(bond.employeeCount) && bond.employeeCount >= 1)) {
      problems.push('bond.employeeCount (>= 1) is required for FIDELITY (except bondType erisa)');
    }

    // Credit-tiered pricing needs the OWNER, not the storefront.
    if (risk.creditConsent === true) {
      if (!present(get(risk, 'applicant.dateOfBirth'))) {
        problems.push('applicant.dateOfBirth is required when creditConsent is true (soft pull runs on the owner)');
      }
      if (!present(get(bond, 'principalAddress.line1')) || !IS_ZIP(get(bond, 'principalAddress.zip'))) {
        problems.push('bond.principalAddress (line1 + zip, the owner\'s home address) is required when creditConsent is true');
      }
    }

    // Date sanity: a project cannot finish before the bond starts.
    const eff = get(risk, 'product.effectiveDate');
    if (IS_DATE(bond.estimatedCompletionDate) && IS_DATE(eff)
      && new Date(bond.estimatedCompletionDate) <= new Date(eff)) {
      problems.push('bond.estimatedCompletionDate must be after product.effectiveDate');
    }
    // Fields inapplicable to a formType are ignored, never rejected - adoption-friendly.
    return problems;
  },
  skeleton: (p) => ({
    // bondType, bondAmount, state, obligee { name, type: FEDERAL|STATE|COUNTY|MUNICIPAL|COURT|PRIVATE },
    // contractAmount, projectDescription, projectLocation, bidDate, bidBondPercent,
    // estimatedCompletionDate, employeeCount, caseNumber, principalAddress,
    // hasPriorSuretyLosses, workingCapital, netWorth, largestContractCompleted
    bond: { ...(p.bond || {}) },
    business: { ...(p.business || {}) },
  }),
});

// ---- Personal umbrella / excess ------------------------------------------
// Adversarially reviewed. Fixes applied: the limit is any positive multiple of
// $1M (a closed 1/2/5M enum banned mainstream 3M and 4M policies); underlying
// items carry unitCount so multi-bike/multi-RV schedules are countable; and the
// "drivers but no auto policy" household (city dweller, rental cars only) is an
// ENGINE acceptability question answered in messages, never a schema rejection.
registerLine('UMBRELLA', {
  label: 'Personal Umbrella / Excess',
  formTypes: null, // PERSONAL_UMBRELLA (default) | EXCESS - defaulted, so not schema-required
  required: [
    ['applicant.lastName'],
    ['applicant.dateOfBirth', IS_DATE, 'must be YYYY-MM-DD'],
    ['coverages.limit', (v) => Number.isInteger(v) && v >= 1_000_000 && v % 1_000_000 === 0,
      'must be a positive multiple of 1000000'],
  ],
  validate: (risk) => {
    const problems = [];
    const ft = String(get(risk, 'product.formType') || 'PERSONAL_UMBRELLA').toUpperCase();
    if (!['PERSONAL_UMBRELLA', 'EXCESS'].includes(ft)) {
      problems.push('product.formType must be PERSONAL_UMBRELLA or EXCESS');
    }
    const stProblem = stateOrRegionProblem(risk, 'umbrella.riskState', 'rating jurisdiction');
    if (stProblem) problems.push(stProblem);

    const underlying = risk.underlying || [];
    const TYPES = ['AUTO', 'HOME', 'CONDO', 'RENTERS', 'LANDLORD', 'WATERCRAFT', 'MOTORCYCLE', 'RV'];
    if (!underlying.length) problems.push('underlying must contain at least one policy');
    underlying.forEach((u, i) => {
      if (!TYPES.includes(u.type)) problems.push(`underlying.${i}.type must be one of ${TYPES.join(', ')}`);
      const liab = u.liability || {};
      if (u.type === 'AUTO') {
        const split = present(liab.perPerson) && present(liab.perOccurrence);
        if (!split && !present(liab.combinedSingleLimit)) {
          problems.push(`underlying.${i}.liability needs perPerson + perOccurrence, or combinedSingleLimit`);
        }
      } else if (!present(liab.perOccurrence) && !present(liab.combinedSingleLimit)) {
        problems.push(`underlying.${i}.liability.perOccurrence is required (home Coverage E maps here)`);
      }
      if (u.unitCount !== undefined && !(Number.isInteger(u.unitCount) && u.unitCount >= 1)) {
        problems.push(`underlying.${i}.unitCount must be an integer >= 1 (units scheduled on that policy)`);
      }
    });
    // The anchor rule: an umbrella sits on a primary auto or residence policy.
    if (underlying.length && !underlying.some((u) => ['AUTO', 'HOME', 'CONDO', 'RENTERS'].includes(u.type))) {
      problems.push('underlying must include at least one AUTO, HOME, CONDO or RENTERS policy');
    }

    const um = risk.umbrella || {};
    for (const k of ['driverCount', 'driversUnder25', 'vehicleCount', 'rentalPropertyCount', 'incidentCount']) {
      if (!(Number.isInteger(um[k]) && um[k] >= 0)) problems.push(`umbrella.${k} must be an integer >= 0 (explicit zero)`);
    }
    if (Number.isInteger(um.driversUnder25) && Number.isInteger(um.driverCount) && um.driversUnder25 > um.driverCount) {
      problems.push('umbrella.driversUnder25 cannot exceed umbrella.driverCount');
    }
    if (Number(um.rentalPropertyCount) > 0 && !underlying.some((u) => ['LANDLORD', 'HOME'].includes(u.type))) {
      problems.push('rental properties declared without an underlying LANDLORD or HOME policy');
    }
    if (underlying.some((u) => u.type === 'LANDLORD') && Number(um.rentalPropertyCount) === 0) {
      problems.push('an underlying LANDLORD policy requires umbrella.rentalPropertyCount >= 1');
    }
    if (present(get(risk, 'coverages.selfInsuredRetention')) && ft === 'EXCESS') {
      problems.push('coverages.selfInsuredRetention is only valid for PERSONAL_UMBRELLA (EXCESS is follow-form)');
    }
    return problems;
  },
  skeleton: (p) => ({
    // [{ type, carrier, policyNumber, expirationDate, unitCount, liability: { perPerson, perOccurrence, combinedSingleLimit, propertyDamage } }]
    underlying: [...(p.underlying || [])],
    // riskState, riskZip, driverCount, driversUnder25, vehicleCount,
    // rentalPropertyCount, incidentCount, watercraft[]. Senior-driver inputs are
    // carrier-specific; adapters may map umbrella.driversOver70 when a carrier asks.
    umbrella: { ...(p.umbrella || {}) },
  }),
});

// ---- Recreational (boat / PWC / motorcycle / RV / golf cart / ATV) -------
// Approved by adversarial review; its improvements are implemented: the
// sub-block must match unitType, pure sailboats (engineType SAIL_AUX/NONE) are
// exempt from the speed/power requirement, and CSL is mutually exclusive with
// split liability limits.
registerLine('RECREATIONAL', {
  label: 'Recreational',
  formTypes: ['BOAT', 'PWC', 'MOTORCYCLE', 'RV', 'GOLF_CART', 'ATV'],
  required: [
    ['applicant.lastName'],
    ['applicant.dateOfBirth', IS_DATE, 'must be YYYY-MM-DD (operator-age rating when operators[] is omitted)'],
  ],
  validate: (risk) => {
    const problems = [];
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    const units = risk.units || [];
    const UNIT_TYPES = ['BOAT', 'PWC', 'MOTORCYCLE', 'RV', 'GOLF_CART', 'ATV'];
    const SUB_BLOCKS = { BOAT: 'boat', PWC: 'boat', MOTORCYCLE: 'motorcycle', RV: 'rv', GOLF_CART: 'golfCart', ATV: 'atv' };

    if (!units.length) problems.push('units must contain at least one unit');
    units.forEach((u, i) => {
      if (!UNIT_TYPES.includes(u.unitType)) problems.push(`units.${i}.unitType must be one of ${UNIT_TYPES.join(', ')}`);
      if (!IS_YEAR(u.year) || Number(u.year) < 1950) problems.push(`units.${i}.year must be 1950..current+1`);
      if (!present(u.make)) problems.push(`units.${i}.make is required`);
      if (!present(u.model)) problems.push(`units.${i}.model is required`);
      const zipOk = countryOf(risk) === 'US' ? IS_ZIP(u.garagingZip)
        : (present(u.garagingZip) && String(u.garagingZip).length <= 10);
      if (!zipOk) problems.push(`units.${i}.garagingZip must be a valid postal code`);

      // The sub-block must agree with unitType - a GOLF_CART carrying a
      // motorcycle{} block is nonsense that must not validate.
      const expected = SUB_BLOCKS[u.unitType];
      for (const blockName of ['boat', 'motorcycle', 'rv', 'golfCart', 'atv']) {
        if (blockName !== expected && u[blockName] && Object.keys(u[blockName]).length) {
          problems.push(`units.${i}.${blockName} does not belong on a ${u.unitType}`);
        }
      }

      if (u.unitType === 'BOAT') {
        if (!IS_POSITIVE(get(u, 'boat.lengthFeet'))) problems.push(`units.${i}.boat.lengthFeet is required for BOAT`);
        if (!present(get(u, 'boat.mooring.type'))) problems.push(`units.${i}.boat.mooring.type is required for BOAT (trailer vs wet-slip is the FL windstorm fork)`);
      }
      if (u.unitType === 'BOAT' || u.unitType === 'PWC') {
        const sail = ['SAIL_AUX', 'NONE'].includes(get(u, 'boat.engineType'));
        if (!sail && !present(get(u, 'boat.maxSpeedMph')) && !present(get(u, 'boat.horsepower'))) {
          problems.push(`units.${i}.boat needs maxSpeedMph or horsepower (pure sail exempt via engineType SAIL_AUX/NONE)`);
        }
      }
      if (u.unitType === 'RV') {
        if (!present(get(u, 'rv.rvClass'))) problems.push(`units.${i}.rv.rvClass is required for RV`);
        if (typeof get(u, 'rv.isFullTimeResidence') !== 'boolean') {
          problems.push(`units.${i}.rv.isFullTimeResidence must be an explicit boolean (full-timer status changes the liability form)`);
        }
      }
      if ((present(u.deductible) || present(u.valuationMethod)) && !present(u.value)) {
        problems.push(`units.${i}: deductible/valuationMethod qualify a physical-damage value that is absent`);
      }
    });

    if (units.length && !units.some((u) => u.unitType === ft)) {
      problems.push(`at least one unit must match product.formType (${ft}); companion units of other types may ride along`);
    }

    // Priceable: liability coverage, or every unit carries a physical-damage value.
    const liab = get(risk, 'coverages.liability');
    if (!liab && units.length && !units.every((u) => IS_POSITIVE(u.value))) {
      problems.push('coverages.liability is required, or every unit must carry a value (physical-damage-only)');
    }
    if (liab && present(liab.combinedSingleLimit)
      && (present(liab.bodilyInjuryPerPerson) || present(liab.bodilyInjuryPerAccident) || present(liab.propertyDamage))) {
      problems.push('coverages.liability: combinedSingleLimit is mutually exclusive with split limits');
    }

    // operators[] omitted = the applicant is the sole operator of every unit.
    // When present, it is the COMPLETE roster (include the applicant if they operate).
    const ops = risk.operators || [];
    if (ops.length) {
      ops.forEach((o, i) => {
        if (!present(o.lastName)) problems.push(`operators.${i}.lastName is required`);
        if (!IS_DATE(o.dateOfBirth)) problems.push(`operators.${i}.dateOfBirth must be YYYY-MM-DD`);
      });
      if (!ops.some((o) => o.excluded !== true)) problems.push('operators must include at least one non-excluded operator');
    }
    return problems;
  },
  skeleton: (p) => ({
    // [{ unitType, year, make, model, identification { hin|vin|serialNumber }, garagingZip,
    //    value, valuationMethod, deductible, usage,
    //    boat { lengthFeet, hullType, maxSpeedMph, horsepower, engineType, engineCount, mooring { type, marinaZip }, navigationArea },
    //    motorcycle { engineCc, style, antiTheftDevice, customPartsValue },
    //    rv { rvClass, isFullTimeResidence, lengthFeet, annualMileage },
    //    golfCart { streetLegal, communityUse, maxSpeedMph, modified },
    //    atv { engineCc, primaryUse } }]
    units: [...(p.units || [])],
    // [{ firstName, lastName, dateOfBirth, relationshipToApplicant, yearsExperience,
    //    motorcycleEndorsement, boatingSafetyCourseCompleted, accidentsLast3Years,
    //    violationsLast3Years, excluded }]
    operators: [...(p.operators || [])],
  }),
});

// ---- Home warranty (service contracts, FL class 0251) --------------------
// Adversarially reviewed. Fixes applied: add-ons live in the UNIVERSAL
// endorsements block (no parallel addOns array); the universal insured rule is
// NOT relaxed; effectiveDate is forward-only within a bounded window; planTier
// is a closed enum, and when omitted the engine returns its LOWEST-priced
// qualifying tier and must say so in messages - the same single-price semantics
// as HEALTH's planId rule. Only state/ZIP/dwellingType rate, so street address
// is optional at quote time.
registerLine('HOME_WARRANTY', {
  label: 'Home Warranty',
  formTypes: null,
  required: [
    ['property.address.state', IS_STATE, 'must be a 2-letter state code'],
    ['property.address.postalCode', IS_ZIP, 'must be a US ZIP'],
    ['property.dwellingType', (v) => ['SFR', 'CONDO', 'TOWNHOME', 'MOBILE_HOME', 'MULTI_UNIT_2_4'].includes(v),
      'must be SFR, CONDO, TOWNHOME, MOBILE_HOME or MULTI_UNIT_2_4'],
    ['warranty.transactionType', (v) => ['REAL_ESTATE', 'DIRECT'].includes(v),
      'must be REAL_ESTATE (attached to a closing) or DIRECT (pricing differs)'],
  ],
  validate: (risk) => {
    const problems = [];
    const eff = get(risk, 'product.effectiveDate');
    if (IS_DATE(eff)) {
      const d = new Date(eff);
      const now = Date.now();
      if (d.getTime() < now - 30 * 24 * 3600 * 1000) problems.push('product.effectiveDate cannot be more than 30 days in the past');
      if (d.getTime() > now + 366 * 24 * 3600 * 1000) problems.push('product.effectiveDate cannot be more than a year out');
    }
    const tt = get(risk, 'warranty.transactionType');
    const tm = get(risk, 'product.termMonths');
    if (present(tm)) {
      const max = tt === 'REAL_ESTATE' ? 14 : 12; // RE promotional terms run 12-14 months
      if (!(Number.isInteger(tm) && tm >= 12 && tm <= max)) {
        problems.push(`product.termMonths must be 12${tt === 'REAL_ESTATE' ? '-14' : ''} for ${tt || 'this'} transactions`);
      }
    }
    const tier = get(risk, 'warranty.planTier');
    if (present(tier) && !['BASIC', 'ENHANCED', 'PREMIUM'].includes(tier)) {
      problems.push('warranty.planTier must be BASIC, ENHANCED or PREMIUM (omit it for the lowest-priced qualifying tier)');
    }
    // Add-ons ride the universal endorsements block: poolSpa, wellPump,
    // secondRefrigerator, roofLeak, septicSystem... A condo does not own its roof.
    if (get(risk, 'property.dwellingType') === 'CONDO' && present(get(risk, 'endorsements.roofLeak'))) {
      problems.push('endorsements.roofLeak is not valid for CONDO (the roof is association property)');
    }
    return problems;
  },
  skeleton: (p) => ({
    property: { ...(p.property || {}), address: { ...((p.property || {}).address || {}) } },
    // { transactionType, planTier, squareFootageBand }
    warranty: { ...(p.warranty || {}) },
  }),
});

// --------------------------------------------------------------------------
// validation + construction
// --------------------------------------------------------------------------

/** @returns {string[]} dotted paths of problems. Empty means valid. */
function validateRisk(risk) {
  if (!risk || typeof risk !== 'object') return ['risk must be an object'];
  const problems = [];

  const lob = String(get(risk, 'product.lineOfBusiness') || 'HO').toUpperCase();
  const line = LINES[lob];
  if (!line) {
    return [`product.lineOfBusiness "${lob}" is not a registered line (have: ${Object.keys(LINES).join(', ')})`];
  }

  // Universal requirements.
  if (present(risk.country) && !IS_COUNTRY(risk.country)) {
    problems.push('country must be an ISO 3166-1 alpha-2 code (defaults to US when omitted)');
  }
  if (!present(get(risk, 'product.effectiveDate'))) problems.push('product.effectiveDate is required');
  else if (!IS_DATE(get(risk, 'product.effectiveDate'))) problems.push('product.effectiveDate must be YYYY-MM-DD');

  // Insured: a person (applicant.lastName) or a business (business.name).
  if (!present(get(risk, 'applicant.lastName')) && !present(get(risk, 'business.name'))) {
    problems.push('applicant.lastName or business.name is required');
  }

  // Form type, when the line constrains it.
  if (line.formTypes) {
    const ft = get(risk, 'product.formType');
    if (!present(ft)) problems.push('product.formType is required');
    else if (!line.formTypes.includes(ft)) {
      problems.push(`product.formType must be one of ${line.formTypes.join(', ')}`);
    }
  }

  // Line-declared required paths.
  for (const [path, test, label] of line.required) {
    const v = get(risk, path);
    if (!present(v)) problems.push(`${path} is required`);
    else if (test && !test(v)) problems.push(`${path} ${label || 'is invalid'}`);
  }

  // Line-specific cross-field rules.
  if (typeof line.validate === 'function') problems.push(...line.validate(risk));

  return problems;
}

/**
 * Build a canonical risk with line-appropriate defaults.
 *
 * There is deliberately NO default state: state selects rate filings, forms and
 * eligibility, so a missing state must fail validation loudly rather than
 * silently become the author's home state. A single-state agency may opt in with
 * makeRisk(partial, { defaultState: 'TX' }), which fills property.address.state
 * only when absent.
 */
function makeRisk(partial = {}, opts = {}) {
  const lob = String((partial.product || {}).lineOfBusiness || 'HO').toUpperCase();
  const line = LINES[lob] || LINES.HO;

  const out = {
    requestId: partial.requestId,
    // ISO 3166-1 alpha-2. The contract was born in the US market but nothing in
    // the response shape is US-specific; premium.currency already travels.
    country: String(partial.country || 'US').toUpperCase(),
    agency: { ...(partial.agency || {}) },
    product: { lineOfBusiness: lob, termMonths: 12, ...(partial.product || {}) },
    applicant: { ...(partial.applicant || {}) },
    coverages: { ...(partial.coverages || {}) },
    mitigation: { ...(partial.mitigation || {}) },

    // Line-specific blocks (property/flood/vehicles/drivers/business/trip...).
    ...line.skeleton(partial),

    // ---------------------------------------------------------------------
    // Universal optional blocks, added after validating this contract
    // against a production FL carrier's 123-field HO3 schema. Optional on
    // every line - validation never requires them - but adapters need a
    // canonical slot to map them FROM, or each carrier grows bespoke risk
    // fields and the one-shape promise quietly dies.
    // ---------------------------------------------------------------------
    endorsements: { ...(partial.endorsements || {}) },
    scheduledProperty: [...(partial.scheduledProperty || [])],
    priorInsurance: { ...(partial.priorInsurance || {}) },
    companionPolicies: [...(partial.companionPolicies || [])],
    features: { ...(partial.features || {}) },

    creditConsent: partial.creditConsent ?? false,
  };

  if (opts.defaultState && out.property && out.property.address && !present(out.property.address.state)) {
    out.property.address.state = opts.defaultState;
  }
  return out;
}

// --------------------------------------------------------------------------
// response helpers (identical across all lines, on purpose)
// --------------------------------------------------------------------------

/**
 * Was this a usable answer? Deliberately explicit rather than truthiness on `premium`,
 * because a carrier can return a premium alongside a decline, and a referral can carry
 * an indicative premium that must not be presented to a client as final.
 */
function isBindable(quote) {
  return quote && quote.status === 'quoted' && quote.premium && typeof quote.premium.annual === 'number';
}

/** Surface only the messages that change what an agent should do. */
function actionableMessages(quote) {
  if (!quote || !Array.isArray(quote.messages)) return [];
  return quote.messages.filter((m) => m && (m.severity === 'error' || m.severity === 'warning'));
}

/** Sort quotes cheapest-first, with declines and referrals after real quotes. */
function rank(quotes) {
  const rankOf = (q) => (q.status === 'quoted' ? 0 : q.status === 'referred' ? 1 : 2);
  return [...quotes].sort((a, b) => {
    const r = rankOf(a) - rankOf(b);
    if (r !== 0) return r;
    const pa = a.premium?.annual ?? Number.POSITIVE_INFINITY;
    const pb = b.premium?.annual ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
}

module.exports = {
  LINES,
  registerLine,
  FORM_TYPES,
  CONSTRUCTION,
  STATUSES,
  validateRisk,
  makeRisk,
  isBindable,
  actionableMessages,
  rank,
};
