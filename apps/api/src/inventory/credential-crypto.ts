import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface SnmpSecret {
  community?: string
  authPassword?: string
  privacyPassword?: string
}

export interface EncryptedCredentialSecret {
  keyVersion: number
  nonce: Uint8Array
  ciphertext: Uint8Array
  authTag: Uint8Array
}

export class CredentialCrypto {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {}

  encrypt(credentialId: string, secret: SnmpSecret): EncryptedCredentialSecret {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 })
    cipher.setAAD(this.aad(credentialId, this.keyVersion))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), 'utf8'),
      cipher.final(),
    ])
    return {
      keyVersion: this.keyVersion,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    }
  }

  decrypt(credentialId: string, encrypted: EncryptedCredentialSecret): SnmpSecret {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`Credential key version ${encrypted.keyVersion} is not available`)
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.nonce), {
      authTagLength: 16,
    })
    decipher.setAAD(this.aad(credentialId, encrypted.keyVersion))
    decipher.setAuthTag(Buffer.from(encrypted.authTag))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as SnmpSecret
  }

  private aad(credentialId: string, version: number): Buffer {
    return Buffer.from(`pricklescope:snmp-credential:${credentialId}:v${version}`, 'utf8')
  }
}
