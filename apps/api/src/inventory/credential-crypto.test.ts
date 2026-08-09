import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { CredentialCrypto } from './credential-crypto.js'

describe('credential encryption', () => {
  it('round-trips secrets with per-record authenticated encryption', () => {
    const crypto = new CredentialCrypto(Buffer.alloc(32, 7), 1)
    const id = randomUUID()
    const encrypted = crypto.encrypt(id, { community: 'very-private-community' })
    expect(Buffer.from(encrypted.ciphertext).toString('utf8')).not.toContain('very-private')
    expect(crypto.decrypt(id, encrypted)).toEqual({ community: 'very-private-community' })
  })

  it('rejects ciphertext moved to another credential record', () => {
    const crypto = new CredentialCrypto(Buffer.alloc(32, 7), 1)
    const encrypted = crypto.encrypt(randomUUID(), { authPassword: 'authentication-secret' })
    expect(() => crypto.decrypt(randomUUID(), encrypted)).toThrow()
  })
})
