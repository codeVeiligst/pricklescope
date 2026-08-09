import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { GrafanaTokenCrypto } from './token-crypto.js'

describe('Grafana service-account token encryption', () => {
  it('round trips without retaining plaintext and binds the envelope to its settings record', () => {
    const crypto = new GrafanaTokenCrypto(randomBytes(32), 7)
    const token = 'glsa_test-token-that-must-remain-write-only'
    const encrypted = crypto.encrypt('primary', token)
    expect(Buffer.from(encrypted.ciphertext).includes(Buffer.from(token))).toBe(false)
    expect(crypto.decrypt('primary', encrypted)).toBe(token)
    expect(() => crypto.decrypt('secondary', encrypted)).toThrow()
  })
})
