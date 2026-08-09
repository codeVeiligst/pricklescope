import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedCollectorConfig {
  keyVersion: number
  nonce: Uint8Array
  ciphertext: Uint8Array
  authTag: Uint8Array
}

export class CollectorConfigCrypto {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {}

  encrypt(revisionId: string, content: string): EncryptedCollectorConfig {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 })
    cipher.setAAD(this.aad(revisionId, this.keyVersion))
    const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
    return {
      keyVersion: this.keyVersion,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    }
  }

  decrypt(revisionId: string, encrypted: EncryptedCollectorConfig): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(
        `Collector configuration key version ${encrypted.keyVersion} is not available`,
      )
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.nonce), {
      authTagLength: 16,
    })
    decipher.setAAD(this.aad(revisionId, encrypted.keyVersion))
    decipher.setAuthTag(Buffer.from(encrypted.authTag))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
  }

  private aad(revisionId: string, version: number): Buffer {
    return Buffer.from(`pricklescope:collector-revision:${revisionId}:v${version}`, 'utf8')
  }
}
