import { Type, type Static } from '@sinclair/typebox'

export const RoleSchema = Type.Union([
  Type.Literal('viewer'),
  Type.Literal('operator'),
  Type.Literal('administrator'),
])
export type Role = Static<typeof RoleSchema>

export const ROLE_ORDER: Readonly<Record<Role, number>> = {
  viewer: 0,
  operator: 1,
  administrator: 2,
}

export const AuthMethodSchema = Type.Union([Type.Literal('local'), Type.Literal('oidc')])
export type AuthMethod = Static<typeof AuthMethodSchema>

export const UserSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: Type.String(),
  displayName: Type.String(),
  email: Type.Union([Type.String({ format: 'email' }), Type.Null()]),
  role: RoleSchema,
  authMethods: Type.Array(AuthMethodSchema),
})
export type User = Static<typeof UserSchema>

export const AuthSessionSchema = Type.Object({
  user: UserSchema,
  csrfToken: Type.String(),
  expiresAt: Type.String({ format: 'date-time' }),
})
export type AuthSession = Static<typeof AuthSessionSchema>

export const LoginRequestSchema = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 128 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
)
export type LoginRequest = Static<typeof LoginRequestSchema>

export const ChangePasswordRequestSchema = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 1024 }),
    newPassword: Type.String({ minLength: 12, maxLength: 1024 }),
  },
  { additionalProperties: false },
)
export type ChangePasswordRequest = Static<typeof ChangePasswordRequestSchema>

export const ManagedUserSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  username: Type.String(),
  displayName: Type.String(),
  email: Type.Union([Type.String({ format: 'email' }), Type.Null()]),
  role: RoleSchema,
  active: Type.Boolean(),
  authMethods: Type.Array(AuthMethodSchema),
  oidcIssuers: Type.Array(Type.String()),
  sessionCount: Type.Integer({ minimum: 0 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  lastLoginAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})
export type ManagedUser = Static<typeof ManagedUserSchema>

export const ManagedUserListSchema = Type.Object({ users: Type.Array(ManagedUserSchema) })

export const CreateLocalUserRequestSchema = Type.Object(
  {
    username: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    }),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
    role: RoleSchema,
    password: Type.String({ minLength: 12, maxLength: 1024 }),
  },
  { additionalProperties: false },
)
export type CreateLocalUserRequest = Static<typeof CreateLocalUserRequestSchema>

export const UpdateManagedUserRequestSchema = Type.Partial(
  Type.Object({
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    email: Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()]),
    role: RoleSchema,
    active: Type.Boolean(),
  }),
  { additionalProperties: false },
)
export type UpdateManagedUserRequest = Static<typeof UpdateManagedUserRequestSchema>

export const ResetUserPasswordRequestSchema = Type.Object(
  { password: Type.String({ minLength: 12, maxLength: 1024 }) },
  { additionalProperties: false },
)
export type ResetUserPasswordRequest = Static<typeof ResetUserPasswordRequestSchema>

export const AuthProvidersSchema = Type.Object({
  local: Type.Boolean(),
  oidc: Type.Object({
    enabled: Type.Boolean(),
    name: Type.String(),
  }),
})
export type AuthProviders = Static<typeof AuthProvidersSchema>

export const OidcSettingsSourceSchema = Type.Union([
  Type.Literal('defaults'),
  Type.Literal('database'),
])
export type OidcSettingsSource = Static<typeof OidcSettingsSourceSchema>

const NullableUriSchema = Type.Union([Type.String({ format: 'uri', maxLength: 2048 }), Type.Null()])

export const OidcProviderSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  name: Type.String(),
  issuerUrl: NullableUriSchema,
  clientId: Type.Union([Type.String(), Type.Null()]),
  clientSecretConfigured: Type.Boolean(),
  redirectUri: Type.String({ format: 'uri' }),
  scopes: Type.String(),
  jitProvisioning: Type.Boolean(),
  adminGroup: Type.Union([Type.String(), Type.Null()]),
  operatorGroup: Type.Union([Type.String(), Type.Null()]),
  source: OidcSettingsSourceSchema,
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})
export type OidcProviderSettings = Static<typeof OidcProviderSettingsSchema>

export const UpdateOidcProviderSettingsRequestSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    issuerUrl: NullableUriSchema,
    clientId: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    clientSecret: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    clearClientSecret: Type.Optional(Type.Boolean()),
    redirectUri: Type.String({ format: 'uri', maxLength: 2048 }),
    scopes: Type.String({ minLength: 1, maxLength: 2048 }),
    jitProvisioning: Type.Boolean(),
    adminGroup: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    operatorGroup: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false },
)
export type UpdateOidcProviderSettingsRequest = Static<
  typeof UpdateOidcProviderSettingsRequestSchema
>

export const OidcDiscoveryResultSchema = Type.Object({
  issuer: Type.String({ format: 'uri' }),
  authorizationEndpoint: Type.String({ format: 'uri' }),
  tokenEndpoint: Type.String({ format: 'uri' }),
  testedAt: Type.String({ format: 'date-time' }),
})
export type OidcDiscoveryResult = Static<typeof OidcDiscoveryResultSchema>

export const DependencyStateSchema = Type.Union([
  Type.Literal('up'),
  Type.Literal('down'),
  Type.Literal('disabled'),
])
export type DependencyState = Static<typeof DependencyStateSchema>

export const DependencyHealthSchema = Type.Object({
  name: Type.String(),
  state: DependencyStateSchema,
  critical: Type.Boolean(),
  latencyMs: Type.Union([Type.Number(), Type.Null()]),
  message: Type.Union([Type.String(), Type.Null()]),
  checkedAt: Type.String({ format: 'date-time' }),
})
export type DependencyHealth = Static<typeof DependencyHealthSchema>

export const SystemHealthSchema = Type.Object({
  status: Type.Union([
    Type.Literal('healthy'),
    Type.Literal('degraded'),
    Type.Literal('unavailable'),
  ]),
  version: Type.String(),
  uptimeSeconds: Type.Number(),
  checkedAt: Type.String({ format: 'date-time' }),
  dependencies: Type.Array(DependencyHealthSchema),
})
export type SystemHealth = Static<typeof SystemHealthSchema>

export const ApiErrorSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
  requestId: Type.Optional(Type.String()),
})
export type ApiError = Static<typeof ApiErrorSchema>

export * from './jobs.js'
export * from './nullable.js'
export * from './inventory.js'
export * from './collectors.js'
export * from './storage.js'
export * from './grafana.js'
export * from './graphs.js'
export * from './charts.js'
export * from './alerts.js'
export * from './sync.js'
