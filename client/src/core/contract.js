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
const FORM_TYPES = ['HO3', 'HO4', 'HO6', 'DP1', 'DP3'];
const CONSTRUCTION = ['FRAME', 'MASONRY', 'MASONRY_VENEER', 'SUPERIOR'];

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
const IS_STATE = (v) => /^[A-Z]{2}$/.test(String(v));
const IS_ZIP = (v) => /^\d{5}(-\d{4})?$/.test(String(v));
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
    ['property.address.line1'],
    ['property.address.state', IS_STATE, 'must be a 2-letter state code'],
    ['property.address.postalCode', IS_ZIP, 'must be a US ZIP'],
    ['property.yearBuilt', IS_YEAR, 'is out of range'],
    ['property.constructionType', (v) => CONSTRUCTION.includes(v), `must be one of ${CONSTRUCTION.join(', ')}`],
    ['coverages.covA', IS_POSITIVE, 'must be a positive number'],
  ],
  skeleton: (p) => ({
    property: {
      occupancy: 'OWNER',
      usage: 'PRIMARY',
      priorClaims: [],
      ...(p.property || {}),
      address: { state: 'FL', ...((p.property || {}).address || {}) },
    },
  }),
});

// ---- Flood (NFIP + private: Neptune, Wright, Floodsol shapes) ------------
registerLine('FLOOD', {
  label: 'Flood',
  formTypes: null,
  required: [
    ['applicant.lastName'],
    ['property.address.line1'],
    ['property.address.state', IS_STATE, 'must be a 2-letter state code'],
    ['property.address.postalCode', IS_ZIP, 'must be a US ZIP'],
    ['property.yearBuilt', IS_YEAR, 'is out of range'],
  ],
  validate: (risk) => {
    const problems = [];
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
      address: { state: 'FL', ...((p.property || {}).address || {}) },
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
  required: [
    ['property.address.state', IS_STATE, 'must be a 2-letter state code (garaging state)'],
    ['property.address.postalCode', IS_ZIP, 'must be a US ZIP (garaging ZIP)'],
  ],
  validate: (risk) => {
    const problems = [];
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
    property: { ...(p.property || {}), address: { state: 'FL', ...((p.property || {}).address || {}) } },
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
    ['property.address.state', IS_STATE, 'must be a 2-letter state code'],
  ],
  validate: (risk) => {
    const problems = [];
    const ft = String(get(risk, 'product.formType') || '').toUpperCase();
    if (ft === 'WC' && !present(get(risk, 'business.payroll'))) {
      problems.push('business.payroll is required for WC');
    }
    if ((ft === 'BOP' || ft === 'PROP') && !present(get(risk, 'property.address.line1'))) {
      problems.push('property.address.line1 is required for premises-based forms');
    }
    return problems;
  },
  skeleton: (p) => ({
    property: { ...(p.property || {}), address: { state: 'FL', ...((p.property || {}).address || {}) } },
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

/** Build a canonical risk with line-appropriate defaults. */
function makeRisk(partial = {}) {
  const lob = String((partial.product || {}).lineOfBusiness || 'HO').toUpperCase();
  const line = LINES[lob] || LINES.HO;

  return {
    requestId: partial.requestId,
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
