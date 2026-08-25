'use strict';

const { TransportError, RateLimitError, AuthError } = require('./errors');
const { redactUrl } = require('./redact');

/**
 * Hardened HTTP.
 *
 * Defaults chosen deliberately:
 *   - HTTPS enforced except on loopback. A carrier credential must never cross plaintext.
 *   - Hard timeout on every request. A rating engine that hangs must not hang us.
 *   - Retry with exponential backoff plus jitter, on transport errors, 429 and 5xx ONLY.
 *     Never on other 4xx, because retrying a rejected request just burns the rate limit.
 *   - Retry-After honoured when the carrier sends it.
 *   - Request bodies are never handed to the logger here. The logger redacts, but the cheapest
 *     way to avoid leaking a body is to never log it.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

function isLoopback(u) {
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
}

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

async function request(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  allowInsecure = false,
  carrier,
  requestId,
  logger,
} = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError(`Malformed URL for carrier ${carrier}`, { carrier, requestId, retryable: false });
  }

  if (parsed.protocol !== 'https:' && !(allowInsecure && isLoopback(parsed))) {
    throw new TransportError(
      `Refusing to send credentials over ${parsed.protocol} to ${parsed.host}. HTTPS is required.`,
      { carrier, requestId, retryable: false },
    );
  }

  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const text = await res.text();

      logger?.debug('carrier http response', {
        carrier, requestId, method, url: redactUrl(url), status: res.status, durationMs, attempt,
      });

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt < retries) {
          const wait = retryAfterMs ?? jitter(500 * 2 ** attempt);
          logger?.warn('rate limited by carrier, backing off', { carrier, requestId, waitMs: wait });
          await new Promise((r) => setTimeout(r, wait));
          attempt += 1;
          continue;
        }
        throw new RateLimitError(`Carrier ${carrier} rate limited the request.`, { carrier, requestId, retryAfterMs });
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`Carrier ${carrier} rejected our credentials (HTTP ${res.status}).`, { carrier, requestId });
      }

      if (res.status >= 500) {
        if (attempt < retries) {
          const wait = jitter(500 * 2 ** attempt);
          logger?.warn('carrier 5xx, retrying', { carrier, requestId, status: res.status, waitMs: wait });
          await new Promise((r) => setTimeout(r, wait));
          attempt += 1;
          continue;
        }
        throw new TransportError(`Carrier ${carrier} returned HTTP ${res.status}.`, { carrier, requestId });
      }

      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { /* some carriers answer in XML or plain text */ }
      }

      return { status: res.status, headers: res.headers, text, json, durationMs };
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof AuthError || err instanceof RateLimitError) throw err;
      if (err instanceof TransportError && !err.retryable) throw err;

      const aborted = err.name === 'AbortError';
      lastErr = aborted
        ? new TransportError(`Carrier ${carrier} timed out after ${timeoutMs}ms.`, { carrier, requestId })
        : new TransportError(`Network failure calling ${carrier}: ${err.message}`, { carrier, requestId, cause: err });

      if (attempt < retries) {
        const wait = jitter(500 * 2 ** attempt);
        logger?.warn('transport failure, retrying', { carrier, requestId, waitMs: wait, attempt });
        await new Promise((r) => setTimeout(r, wait));
        attempt += 1;
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr || new TransportError(`Exhausted retries calling ${carrier}.`, { carrier, requestId });
}

module.exports = { request, DEFAULT_TIMEOUT_MS };
