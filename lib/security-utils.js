import crypto from 'node:crypto';

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));

  if (left.length !== right.length) {
    if (left.length) {
      crypto.timingSafeEqual(left, left);
    }

    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function buildHelmetOptions(securityConfig) {
  const directives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    ...(securityConfig.cookieSecure ? { upgradeInsecureRequests: [] } : {})
  };

  const csp = {
    useDefaults: false,
    directives
  };

  return {
    contentSecurityPolicy: securityConfig.cspReportOnly
      ? { ...csp, reportOnly: true }
      : csp,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: securityConfig.hstsEnabled
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false
  };
}
