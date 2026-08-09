import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedOidcSecret {
  keyVersion: number
  nonce: Uint8Array
  ciphertext: Uint8Array
  authTag: Uint8Array
}

export class OidcSecretCrypto {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {}

  encrypt(providerKey: string, secret: string): EncryptedOidcSecret {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 })
    cipher.setAAD(this.aad(providerKey, this.keyVersion))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return {
      keyVersion: this.keyVersion,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    }
  }

  decrypt(providerKey: string, encrypted: EncryptedOidcSecret): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`OIDC secret key version ${encrypted.keyVersion} is not available`)
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.nonce), {
      authTagLength: 16,
    })
    decipher.setAAD(this.aad(providerKey, encrypted.keyVersion))
    decipher.setAuthTag(Buffer.from(encrypted.authTag))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
  }

  private aad(providerKey: string, version: number): Buffer {
    return Buffer.from(`pricklescope:oidc-provider:${providerKey}:v${version}`, 'utf8')
  }
}
