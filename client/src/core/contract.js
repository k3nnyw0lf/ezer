'use strict';

/**
 * The canonical risk and quote shapes.
 *
 * Everything in this client speaks these two shapes. Carrier-specific vocabulary lives only in
 * adapter definitions, which means adding a carrier never changes calling code.
 *
 * The response shape mirrors the published EZer contract deliberately, so the mock carrier and
 * conformance tester in the kit exercise the same structures this client consumes.
 */

const FORM_TYPES = ['HO3', 'HO4', 'HO6', 'DP1', 'DP3'];
const CONSTRUCTION = ['FRAME', 'MASONRY', 'MASONRY_VENEER', 'SUPERIOR'];
const STATUSES = ['quoted', 'referred', 'declined'];

/** @returns {string[]} dotted paths of problems. Empty means valid. */
function validateRisk(risk) {
  const problems = [];
  const need = (path, test, label) => {
    const value = path.split('.').reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), risk);
    if (value === undefined || value === null || value === '') {
      problems.push(`${path} is required`);
      return;
    }
    if (test && !test(value)) problems.push(`${path} ${label}`);
  };

  if (!risk || typeof risk !== 'object') return ['risk must be an object'];

  need('product.formType', (v) => FORM_TYPES.includes(v), `must be one of ${FORM_TYPES.join(', ')}`);
  need('product.effectiveDate', (v) => /^\d{4}-\d{2}-\d{2}$/.test(v), 'must be YYYY-MM-DD');
  need('applicant.lastName');
  need('property.address.line1');
  need('property.address.state', (v) => /^[A-Z]{2}$/.test(v), 'must be a 2-letter state code');
  need('property.address.postalCode', (v) => /^\d{5}(-\d{4})?$/.test(String(v)), 'must be a US ZIP');
  need('property.yearBuilt', (v) => Number(v) > 1800 && Number(v) <= new Date().getUTCFullYear() + 1, 'is out of range');
  need('property.constructionType', (v) => CONSTRUCTION.includes(v), `must be one of ${CONSTRUCTION.join(', ')}`);
  need('coverages.covA', (v) => Number(v) > 0, 'must be a positive number');

  return problems;
}

/** Build a canonical risk with sane defaults, so callers supply only what varies. */
function makeRisk(partial = {}) {
  return {
    requestId: partial.requestId,
    agency: { ...(partial.agency || {}) },
    product: { lineOfBusiness: 'HO', termMonths: 12, ...(partial.product || {}) },
    applicant: { ...(partial.applicant || {}) },
    property: {
      occupancy: 'OWNER',
      usage: 'PRIMARY',
      priorClaims: [],
      ...(partial.property || {}),
      address: { state: 'FL', ...((partial.property || {}).address || {}) },
    },
    coverages: { ...(partial.coverages || {}) },
    mitigation: { ...(partial.mitigation || {}) },

    // ---------------------------------------------------------------------
    // Optional blocks, added after validating this contract against a live
    // FL carrier's production HO3 schema (123 fields). The core above covers
    // the rating spine; these carry what real carriers additionally rate on.
    // All optional - validation does not require them - but adapters need
    // somewhere canonical to map them FROM, or every carrier grows bespoke
    // risk fields and the "one canonical shape" promise quietly dies.
    // ---------------------------------------------------------------------

    // Endorsements / optional coverages, keyed by a neutral code with a
    // boolean or limit value. e.g. { waterDamage: true, animalLiability: 300000,
    // ordinanceOrLaw: '25%', equipmentBreakdown: true, sinkhole: false }
    endorsements: { ...(partial.endorsements || {}) },

    // Scheduled personal property: [{ class: 'JEWELRY', value: 15000 }, ...]
    scheduledProperty: [...(partial.scheduledProperty || [])],

    // Prior carrier and companion policies - FL carriers rate and gate on both.
    // priorInsurance: { carrier, policyNumber, expirationDate, yearsWithPrior }
    priorInsurance: { ...(partial.priorInsurance || {}) },
    // companionPolicies: [{ type: 'FLOOD', carrier, policyNumber }, ...]
    companionPolicies: [...(partial.companionPolicies || [])],

    // Protective devices and discount-bearing features.
    // e.g. { burglarAlarm: 'CENTRAL', fireAlarm: 'CENTRAL', securedCommunity: true,
    //        sprinklers: false, waterLeakDetection: true }
    features: { ...(partial.features || {}) },

    creditConsent: partial.creditConsent ?? false,
  };
}

/**
 * Was this a usable answer?
 *
 * Deliberately explicit rather than truthiness on `premium`, because a carrier can return a
 * premium alongside a decline, and a referral can carry an indicative premium that must not be
 * presented to a client as final.
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
  FORM_TYPES,
  CONSTRUCTION,
  STATUSES,
  validateRisk,
  makeRisk,
  isBindable,
  actionableMessages,
  rank,
};
