import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { CollectorConfigCrypto } from './config-crypto.js'

describe('collector configuration encryption', () => {
  it('encrypts configuration and binds it to its revision', () => {
    const crypto = new CollectorConfigCrypto(Buffer.alloc(32, 9), 1)
    const id = randomUUID()
    const encrypted = crypto.encrypt(id, 'community = "not-for-the-database"')
    expect(Buffer.from(encrypted.ciphertext).toString()).not.toContain('not-for-the-database')
    expect(crypto.decrypt(id, encrypted)).toContain('not-for-the-database')
    expect(() => crypto.decrypt(randomUUID(), encrypted)).toThrow()
  })
})
