import { Type, type NumberOptions, type StringOptions } from '@sinclair/typebox'

/**
 * Nullable request fields, written as one schema with a type array rather than
 * `Type.Union([…, Type.Null()])`.
 *
 * Ajv — which Fastify uses to validate request bodies — coerces types inside
 * `anyOf` and keeps the first branch that validates. An explicit `null` is
 * therefore coerced to `''` or `0`, and the null branch is never reached unless
 * that coerced value happens to fail. Clearing an optional field then silently
 * stores an empty string or a zero threshold instead of nothing.
 *
 * A single schema with `type: ['string', 'null']` accepts null outright, so
 * there is nothing to coerce. Response schemas can keep the union: Fastify
 * serializes responses and never coerces them.
 */
export const NullableString = (options: StringOptions = {}) =>
  Type.Unsafe<string | null>({ ...options, type: ['string', 'null'] })

export const NullableNumber = (options: NumberOptions = {}) =>
  Type.Unsafe<number | null>({ ...options, type: ['number', 'null'] })
