import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedGrafanaToken {
  keyVersion: number
  nonce: Uint8Array
  ciphertext: Uint8Array
  authTag: Uint8Array
}

export class GrafanaTokenCrypto {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {}

  encrypt(settingsKey: string, token: string): EncryptedGrafanaToken {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 })
    cipher.setAAD(this.aad(settingsKey, this.keyVersion))
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return {
      keyVersion: this.keyVersion,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    }
  }

  decrypt(settingsKey: string, encrypted: EncryptedGrafanaToken): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`Grafana token key version ${encrypted.keyVersion} is not available`)
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.nonce), {
      authTagLength: 16,
    })
    decipher.setAAD(this.aad(settingsKey, encrypted.keyVersion))
    decipher.setAuthTag(Buffer.from(encrypted.authTag))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
  }

  private aad(settingsKey: string, version: number): Buffer {
    return Buffer.from(`pricklescope:grafana-service-token:${settingsKey}:v${version}`, 'utf8')
  }
}
