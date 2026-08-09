/**
 * Field paths the request log must never print.
 *
 * Kept here rather than inline in the Fastify options so a test can hold it to
 * the set of secret-bearing fields the contracts actually define — the list is
 * the kind that silently falls behind the schema it is meant to cover, and the
 * failure mode is a credential in a log file nobody looks at until it matters.
 *
 * `*.field` matches at any depth; the explicit `req.body.field` entries are for
 * the top level, which the wildcard does not cover on its own.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',

  // Sign-in and password management.
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',

  // SNMP credentials.
  '*.community',
  '*.authPassword',
  '*.privacyPassword',

  // OIDC, Grafana, and mail-provider credentials.
  '*.clientSecret',
  'req.body.clientSecret',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.token',

  // Configuration that carries a key or a password inside it.
  '*.credentialKey',
  '*.databaseUrl',
  '*.questdbDatabaseUrl',
] as const

export const LOG_REDACT_CENSOR = '[REDACTED]'
