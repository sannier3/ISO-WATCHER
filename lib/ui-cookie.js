import { parseBool } from './config.js';

export const UI_SESSION_COOKIE = 'iw_ui_session';

export function resolveUiSessionToken(request) {
  const header = request.headers['x-ui-session'];

  if (header) {
    return String(header);
  }

  const cookie = request.cookies?.[UI_SESSION_COOKIE];

  return cookie ? String(cookie) : null;
}

export function setUiSessionCookie(reply, token, securityConfig) {
  const maxAgeSec = Math.floor((securityConfig.sessionMaxAgeMs || 12 * 60 * 60 * 1000) / 1000);

  reply.setCookie(UI_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: securityConfig.cookieSecure,
    sameSite: securityConfig.cookieSameSite,
    maxAge: maxAgeSec,
    signed: false
  });
}

export function clearUiSessionCookie(reply, securityConfig) {
  reply.clearCookie(UI_SESSION_COOKIE, {
    path: '/',
    secure: securityConfig.cookieSecure,
    sameSite: securityConfig.cookieSameSite
  });
}

export function loadSecurityConfigFromEnv() {
  return {
    trustProxy: parseBool(process.env.TRUST_PROXY, false),
    cookieSecure: parseBool(process.env.UI_SESSION_COOKIE_SECURE, false),
    cookieSameSite: String(process.env.UI_SESSION_COOKIE_SAME_SITE || 'lax').toLowerCase(),
    sessionMaxAgeMs: Number(process.env.UI_SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
    loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
    loginWindowMs: Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000),
    loginLockoutMs: Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000),
    apiRateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 300),
    apiRateLimitWindowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000),
    hstsEnabled: parseBool(process.env.SECURITY_HSTS_ENABLED, false),
    cspReportOnly: parseBool(process.env.CSP_REPORT_ONLY, false)
  };
}
