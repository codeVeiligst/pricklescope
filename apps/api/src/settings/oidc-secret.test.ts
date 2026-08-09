import { describe, expect, it } from 'vitest'

import { OidcSecretCrypto } from './oidc-secret.js'

describe('OIDC client-secret encryption', () => {
  it('round-trips a secret with authenticated provider context', () => {
    const crypto = new OidcSecretCrypto(Buffer.alloc(32, 7), 3)
    const plaintext = 'client-secret-that-must-remain-write-only'
    const encrypted = crypto.encrypt('primary', plaintext)

    expect(Buffer.from(encrypted.ciphertext).includes(Buffer.from(plaintext))).toBe(false)
    expect(crypto.decrypt('primary', encrypted)).toBe(plaintext)
    expect(() => crypto.decrypt('different-provider', encrypted)).toThrow()
  })
})
