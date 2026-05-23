/**
 * Sessions signées pour les interfaces web (évite d'exposer le token partagé au navigateur).
 */
import crypto from 'node:crypto';

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function createUiSessionStore(secret) {
  if (!secret) {
    throw new Error('UI session secret is required');
  }

  return {
    issue(actor) {
      const payload = {
        actor: {
          username: String(actor.username || 'ui'),
          type: String(actor.type || 'internal')
        },
        exp: Date.now() + SESSION_MAX_AGE_MS
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
      return `${b64}.${sig}`;
    },

    verify(token) {
      if (!token || typeof token !== 'string') {
        return null;
      }

      const dot = token.lastIndexOf('.');

      if (dot < 1) {
        return null;
      }

      const b64 = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');

      if (sig.length !== expected.length) {
        return null;
      }

      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return null;
      }

      try {
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));

        if (!payload?.exp || payload.exp < Date.now()) {
          return null;
        }

        return payload.actor;
      } catch {
        return null;
      }
    }
  };
}

export function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];

  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }

  return request.ip || '';
}

export function isPrivateIp(ip) {
  if (!ip) {
    return false;
  }

  const normalized = String(ip).replace(/^::ffff:/, '');

  if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') {
    return true;
  }

  const parts = normalized.split('.').map((p) => Number(p));

  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }

  if (parts[0] === 10) {
    return true;
  }

  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }

  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }

  return false;
}

export function assertPrivateNetwork(request, reply, { enabled }) {
  if (!enabled) {
    return true;
  }

  if (isPrivateIp(getClientIp(request))) {
    return true;
  }

  reply.code(403).send({ error: 'private_network_required' });
  return false;
}
