/**
 * Limitation des tentatives de connexion (anti brute-force) par IP.
 */
export function createLoginGuard({
  maxAttempts = 5,
  windowMs = 15 * 60 * 1000,
  lockoutMs = 15 * 60 * 1000
} = {}) {
  const buckets = new Map();

  function prune() {
    const now = Date.now();

    for (const [key, entry] of buckets.entries()) {
      if (entry.lockUntil && entry.lockUntil <= now) {
        buckets.delete(key);
        continue;
      }

      entry.attempts = entry.attempts.filter((t) => now - t < windowMs);

      if (!entry.attempts.length && (!entry.lockUntil || entry.lockUntil <= now)) {
        buckets.delete(key);
      }
    }
  }

  function check(key) {
    prune();
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry) {
      return { allowed: true, retryAfterSec: 0 };
    }

    if (entry.lockUntil && entry.lockUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000)
      };
    }

    const recent = entry.attempts.filter((t) => now - t < windowMs);

    if (recent.length >= maxAttempts) {
      entry.lockUntil = now + lockoutMs;
      entry.attempts = recent;
      buckets.set(key, entry);
      return {
        allowed: false,
        retryAfterSec: Math.ceil(lockoutMs / 1000)
      };
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  function recordFailure(key) {
    prune();
    const now = Date.now();
    const entry = buckets.get(key) || { attempts: [], lockUntil: 0 };
    entry.attempts.push(now);
    entry.attempts = entry.attempts.filter((t) => now - t < windowMs);

    if (entry.attempts.length >= maxAttempts) {
      entry.lockUntil = now + lockoutMs;
    }

    buckets.set(key, entry);
  }

  function recordSuccess(key) {
    buckets.delete(key);
  }

  return { check, recordFailure, recordSuccess };
}

export function sendRateLimited(reply, retryAfterSec) {
  if (retryAfterSec > 0) {
    reply.header('Retry-After', String(retryAfterSec));
  }

  return reply.code(429).send({
    error: 'too_many_attempts',
    message: 'Trop de tentatives. Réessayez plus tard.',
    retry_after_seconds: retryAfterSec
  });
}
