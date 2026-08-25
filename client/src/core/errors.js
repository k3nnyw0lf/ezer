'use strict';

/** Base for every error this client raises. Carries a requestId so logs correlate with carrier logs. */
class QuoteClientError extends Error {
  constructor(message, { code = 'CLIENT_ERROR', carrier, requestId, retryable = false, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.carrier = carrier;
    this.requestId = requestId;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** Credential missing, rejected, or expired. Never retried automatically beyond one re-auth. */
class AuthError extends QuoteClientError {
  constructor(message, opts = {}) {
    super(message, { code: 'AUTH_ERROR', retryable: false, ...opts });
  }
}

/** Our canonical risk failed validation before we ever called the carrier. */
class ValidationError extends QuoteClientError {
  constructor(message, { fields = [], ...opts } = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, ...opts });
    this.fields = fields;
  }
}

/** Transport, timeout, or 5xx. Safe to retry with backoff. */
class TransportError extends QuoteClientError {
  constructor(message, opts = {}) {
    super(message, { code: 'TRANSPORT_ERROR', retryable: true, ...opts });
  }
}

/** Carrier said slow down. Carries retryAfterMs when the carrier told us how long. */
class RateLimitError extends QuoteClientError {
  constructor(message, { retryAfterMs, ...opts } = {}) {
    super(message, { code: 'RATE_LIMITED', retryable: true, ...opts });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The carrier answered correctly and the answer was a refusal.
 *
 * This is NOT an error condition for the transport layer and must never be conflated with one.
 * We model it as a value, not a throw - see contract.js. This class exists only for callers that
 * explicitly opt into throw-on-decline.
 */
class DeclinedError extends QuoteClientError {
  constructor(message, { messages = [], ...opts } = {}) {
    super(message, { code: 'DECLINED', retryable: false, ...opts });
    this.messages = messages;
  }
}

module.exports = {
  QuoteClientError,
  AuthError,
  ValidationError,
  TransportError,
  RateLimitError,
  DeclinedError,
};
