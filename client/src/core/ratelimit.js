'use strict';

/**
 * Token-bucket throttle, per carrier.
 *
 * We self-throttle by default rather than discovering a carrier's limit by tripping it. A small
 * agency that hammers a carrier's sandbox is a support ticket and a reason to revoke access, so
 * the default here is deliberately conservative.
 */
class TokenBucket {
  constructor({ ratePerSecond = 2, burst = 4 } = {}) {
    this.rate = Math.max(0.01, ratePerSecond);
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
  }

  /** Resolves when a token is available. Never rejects. */
  async take() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil((deficit / this.rate) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return waitMs;
  }
}

const buckets = new Map();

function bucketFor(carrierId, limits) {
  if (!buckets.has(carrierId)) buckets.set(carrierId, new TokenBucket(limits));
  return buckets.get(carrierId);
}

function resetBuckets() {
  buckets.clear();
}

module.exports = { TokenBucket, bucketFor, resetBuckets };
