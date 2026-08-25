'use strict';

/**
 * Redaction. This module exists because a token has already leaked into a transcript once.
 *
 * Two independent layers, because either alone fails:
 *
 *   1. VALUE redaction — every secret handed to the client is registered here, and any occurrence
 *      of that exact string is scrubbed from anything we print. This catches secrets that end up
 *      somewhere we did not anticipate: an error message, a URL, a nested response echo.
 *
 *   2. KEY redaction — fields whose NAME looks sensitive are scrubbed regardless of value. This
 *      catches secrets we never registered, such as a token the carrier invented and returned.
 *
 * Layer 1 catches known secrets in unknown places. Layer 2 catches unknown secrets in known places.
 * A real leak usually needs both to be missing.
 */

const MIN_REGISTERED_LENGTH = 6; // below this, redaction would mangle ordinary text

/** @type {Set<string>} */
const registered = new Set();

/**
 * Register a secret value so it is scrubbed everywhere, forever, in this process.
 * Call this the moment a credential enters memory — before the first request, not after.
 */
function registerSecret(value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < MIN_REGISTERED_LENGTH) return;
  registered.add(v);
}

function clearRegisteredSecrets() {
  registered.clear();
}

// Field names that are sensitive regardless of content.
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|authorization|auth|apikey|api_key|client_secret|credential|cookie|session|bearer|signature|private)/i;

// Personally identifying fields. Not secrets, but they do not belong in logs.
const PII_KEY = /(ssn|socialsecurity|taxid|ein|dateofbirth|dob|birthdt|birthdate|driverlicense|licensenumber|accountnumber|routingnumber|cardnumber|cvv)/i;

const REDACTED = '[REDACTED]';
const PII_MASK = '[PII]';

/** Scrub registered secret values out of an arbitrary string. */
function scrubString(str) {
  if (typeof str !== 'string' || !str) return str;
  let out = str;
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // Opportunistic: Bearer tokens and long opaque blobs in free text.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi, `$1${REDACTED}`);
  return out;
}

/**
 * Deep-redact a value for logging.
 * Never mutates the input — callers routinely log an object they are about to send.
 */
function redact(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[FUNCTION]';

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }

  if (typeof value === 'object') {
    // Headers and Map-likes
    if (typeof value.entries === 'function' && !(value instanceof Date)) {
      const out = {};
      try {
        for (const [k, v] of value.entries()) {
          out[k] = SENSITIVE_KEY.test(String(k)) ? REDACTED : redact(v, depth + 1);
        }
        return out;
      } catch {
        /* fall through */
      }
    }
    if (value instanceof Date) return value.toISOString();

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) out[k] = REDACTED;
      else if (PII_KEY.test(k)) out[k] = PII_MASK;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }

  return '[UNKNOWN]';
}

/**
 * Redact a URL: strips credentials in the authority and scrubs query values.
 * Query strings are a classic accidental-secret location.
 */
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return scrubString(url);
  }
  if (u.username || u.password) {
    u.username = REDACTED;
    u.password = '';
  }
  for (const key of [...u.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key) || PII_KEY.test(key)) u.searchParams.set(key, REDACTED);
    else u.searchParams.set(key, scrubString(u.searchParams.get(key)));
  }
  return scrubString(u.toString());
}

module.exports = {
  registerSecret,
  clearRegisteredSecrets,
  redact,
  redactUrl,
  scrubString,
  REDACTED,
  _internal: { SENSITIVE_KEY, PII_KEY },
};
