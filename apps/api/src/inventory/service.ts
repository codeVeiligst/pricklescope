import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import {
  inventorySnmp,
  testSnmpConnection,
  type SnmpAccess,
  type SnmpTarget,
} from '@pricklescope/adapters'
import type {
  CollectorKind,
  CollectorSelection,
  CreateSnmpCredentialRequest,
  InventorySnapshot,
  SnmpCredential,
  UpdateSnmpCredentialRequest,
} from '@pricklescope/contracts'

import { HttpError } from '../errors.js'
import type { CredentialCrypto, SnmpSecret } from './credential-crypto.js'
import { diffInventory } from './diff.js'
import type { InventoryStore, ProbeConfiguration } from './store.js'

function requireValue(value: string | undefined, message: string): string {
  if (!value) throw new HttpError(400, 'credential_invalid', message)
  return value
}

function secretValues(access: SnmpAccess): string[] {
  return access.version === '2c'
    ? [access.community]
    : [access.authPassword, access.privacyPassword].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
}

function sanitizedError(error: unknown, access: SnmpAccess): string {
  const detail = error instanceof Error ? error.message : 'The SNMP request failed'
  return secretValues(access)
    .reduce((message, secret) => message.replaceAll(secret, '[REDACTED]'), detail)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

export function resolveCollector(selection: CollectorSelection = 'auto'): CollectorKind {
  if (selection === 'alloy') {
    throw new HttpError(
      400,
      'collector_unsupported',
      'Grafana Alloy is not built; use Auto or Telegraf',
    )
  }
  return 'telegraf'
}

export function validateTarget(target: string, transport: 'udp4' | 'udp6'): string {
  const normalized = target.trim()
  const version = isIP(normalized)
  if (version === 4 && transport !== 'udp4') {
    throw new HttpError(400, 'target_invalid', 'An IPv4 address requires UDP/IPv4')
  }
  if (version === 6 && transport !== 'udp6') {
    throw new HttpError(400, 'target_invalid', 'An IPv6 address requires UDP/IPv6')
  }
  if (!version && !/^(?=.{1,253}$)[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?$/.test(normalized)) {
    throw new HttpError(400, 'target_invalid', 'Enter a hostname or an IPv4/IPv6 address')
  }
  return normalized
}

export class CredentialService {
  constructor(
    private readonly store: InventoryStore,
    private readonly crypto: CredentialCrypto,
  ) {}

  async create(input: CreateSnmpCredentialRequest): Promise<SnmpCredential> {
    const id = randomUUID()
    if (input.version === '2c') {
      const secret = {
        community: requireValue(input.community, 'An SNMP v2c community is required'),
      }
      return this.store.createCredential({
        id,
        name: input.name,
        version: '2c',
        username: null,
        securityLevel: null,
        authProtocol: null,
        privacyProtocol: null,
        encrypted: this.crypto.encrypt(id, secret),
      })
    }
    const securityLevel = input.securityLevel ?? 'authPriv'
    const secret = this.validateV3Secret(securityLevel, {
      ...(input.authPassword ? { authPassword: input.authPassword } : {}),
      ...(input.privacyPassword ? { privacyPassword: input.privacyPassword } : {}),
    })
    return this.store.createCredential({
      id,
      name: input.name,
      version: '3',
      username: requireValue(input.username, 'An SNMP v3 username is required'),
      securityLevel,
      authProtocol: securityLevel === 'noAuthNoPriv' ? null : (input.authProtocol ?? 'sha256'),
      privacyProtocol: securityLevel === 'authPriv' ? (input.privacyProtocol ?? 'aes') : null,
      encrypted: this.crypto.encrypt(id, secret),
    })
  }

  async update(id: string, input: UpdateSnmpCredentialRequest): Promise<SnmpCredential | null> {
    const existing = await this.store.getStoredCredential(id)
    if (!existing) return null
    const previous = this.crypto.decrypt(id, {
      keyVersion: existing.secret_key_version,
      nonce: existing.secret_nonce,
      ciphertext: existing.secret_ciphertext,
      authTag: existing.secret_auth_tag,
    })
    if (existing.version === '2c') {
      const secret = {
        community: requireValue(
          input.community ?? previous.community,
          'An SNMP v2c community is required',
        ),
      }
      return this.store.updateCredential(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.community ? { encrypted: this.crypto.encrypt(id, secret) } : {}),
      })
    }
    const level = input.securityLevel ?? existing.security_level ?? 'authPriv'
    const authPassword = input.authPassword ?? previous.authPassword
    const privacyPassword = input.privacyPassword ?? previous.privacyPassword
    const secret = this.validateV3Secret(level, {
      ...(authPassword ? { authPassword } : {}),
      ...(privacyPassword ? { privacyPassword } : {}),
    })
    return this.store.updateCredential(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      username: input.username ?? existing.username,
      securityLevel: level,
      authProtocol:
        level === 'noAuthNoPriv'
          ? null
          : (input.authProtocol ?? existing.auth_protocol ?? 'sha256'),
      privacyProtocol:
        level === 'authPriv' ? (input.privacyProtocol ?? existing.privacy_protocol ?? 'aes') : null,
      encrypted: this.crypto.encrypt(id, secret),
    })
  }

  private validateV3Secret(
    level: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv',
    secret: SnmpSecret,
  ): SnmpSecret {
    if (level === 'noAuthNoPriv') return {}
    const authPassword = requireValue(
      secret.authPassword,
      'An authentication passphrase is required for this security level',
    )
    if (level === 'authNoPriv') return { authPassword }
    const privacyPassword = requireValue(
      secret.privacyPassword,
      'A privacy passphrase is required for authPriv',
    )
    return { authPassword, privacyPassword }
  }
}

export class SnmpInventoryService {
  constructor(
    private readonly store: InventoryStore,
    private readonly crypto: CredentialCrypto,
  ) {}

  async test(sourceId: string, signal: AbortSignal): Promise<object> {
    const configuration = await this.configuration(sourceId)
    const target = this.target(configuration)
    await this.store.markTesting(sourceId)
    try {
      const system = await testSnmpConnection(target, signal)
      await this.store.recordTest(sourceId, {
        reachable: true,
        message: system.name ? `Responded as ${system.name}` : 'SNMP responded successfully',
        system,
      })
      return { sourceId, reachable: true, system }
    } catch (error) {
      const message = sanitizedError(error, target.access)
      await this.store.recordTest(sourceId, { reachable: false, message })
      throw new Error(`SNMP connection failed: ${message}`, { cause: error })
    }
  }

  async inventory(
    sourceId: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<InventorySnapshot> {
    const configuration = await this.configuration(sourceId)
    const target = this.target(configuration)
    try {
      const result = await inventorySnmp(
        target,
        { collectInterfaces: configuration.profile.collectInterfaces },
        signal,
      )
      const previous = await this.store.getAppliedInventory(sourceId)
      const diff = diffInventory(result, previous)
      return this.store.saveSnapshot({
        sourceId,
        jobId,
        system: result.system,
        interfaces: result.interfaces,
        diff,
        partial: result.partial,
        errors: result.errors,
      })
    } catch (error) {
      const message = sanitizedError(error, target.access)
      await this.store.recordInventoryFailure(sourceId, `Inventory failed: ${message}`)
      throw new Error(`SNMP inventory failed: ${message}`, { cause: error })
    }
  }

  private async configuration(sourceId: string): Promise<ProbeConfiguration> {
    const configuration = await this.store.getProbeConfiguration(sourceId)
    if (!configuration) throw new Error('The source or its SNMP check no longer exists')
    return configuration
  }

  private target(configuration: ProbeConfiguration): SnmpTarget {
    const credential = configuration.credential
    const secret = this.crypto.decrypt(credential.id, {
      keyVersion: credential.secret_key_version,
      nonce: credential.secret_nonce,
      ciphertext: credential.secret_ciphertext,
      authTag: credential.secret_auth_tag,
    })
    let access: SnmpAccess
    if (credential.version === '2c') {
      access = {
        version: '2c',
        community: requireValue(secret.community, 'The SNMP v2c credential is incomplete'),
      }
    } else {
      access = {
        version: '3',
        username: requireValue(credential.username ?? undefined, 'The SNMP v3 username is missing'),
        securityLevel: credential.security_level ?? 'authPriv',
        ...(credential.auth_protocol ? { authProtocol: credential.auth_protocol } : {}),
        ...(secret.authPassword ? { authPassword: secret.authPassword } : {}),
        ...(credential.privacy_protocol ? { privacyProtocol: credential.privacy_protocol } : {}),
        ...(secret.privacyPassword ? { privacyPassword: secret.privacyPassword } : {}),
      }
    }
    return {
      target: configuration.target,
      port: configuration.port,
      transport: configuration.transport,
      timeoutMs: configuration.profile.timeoutMs,
      retries: configuration.profile.retries,
      access,
    }
  }
}

export function normalizedSourceInput<T extends { target: string; transport?: 'udp4' | 'udp6' }>(
  input: T,
): T {
  return { ...input, target: validateTarget(input.target, input.transport ?? 'udp4') }
}
