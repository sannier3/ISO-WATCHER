/**
 * Limite globale douce sur /api/v1 (par IP).
 */
export function createApiRateLimiter({ max = 300, windowMs = 60 * 1000 } = {}) {
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    hits.set(key, entry);

    if (entry.count > max) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.resetAt - now) / 1000)
      };
    }

    return { allowed: true, retryAfterSec: 0 };
  };
}
