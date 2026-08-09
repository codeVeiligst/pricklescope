import { randomUUID } from 'node:crypto'

import {
  checkTcpDependency,
  telegrafAdapter,
  type TelegrafCheckDesiredState,
  type TelegrafSnmpCredential,
} from '@pricklescope/adapters'
import type { CollectorRevision, TelegrafCollectorStatus } from '@pricklescope/contracts'

import type { AuthStore } from '../auth/store.js'
import type { AppConfig } from '../config.js'
import type { CredentialCrypto, SnmpSecret } from '../inventory/credential-crypto.js'
import { CollectorConfigCrypto } from './config-crypto.js'
import type { SyncProbe } from '../sync/probe.js'
import type { TelegrafConfigPublisher } from './publisher.js'
import {
  toCollectorRevision,
  type CollectorAssignmentRow,
  type CollectorStore,
  type StoredCollectorRevision,
} from './store.js'

export interface ReconciliationResult {
  changed: boolean
  revision: CollectorRevision
}

function encryptedCredential(row: CollectorAssignmentRow['credential']) {
  return {
    keyVersion: row.secret_key_version,
    nonce: row.secret_nonce,
    ciphertext: row.secret_ciphertext,
    authTag: row.secret_auth_tag,
  }
}

function telegrafCredential(
  row: CollectorAssignmentRow['credential'],
  secret: SnmpSecret,
): TelegrafSnmpCredential {
  if (row.version === '2c') return { version: '2c', community: secret.community ?? '' }
  if (!row.username || !row.security_level) {
    throw new Error(`SNMPv3 credential ${row.name} is incomplete`)
  }
  if (row.security_level === 'noAuthNoPriv') {
    return { version: '3', username: row.username, securityLevel: row.security_level }
  }
  if (!row.auth_protocol) throw new Error(`SNMPv3 credential ${row.name} has no auth protocol`)
  if (row.security_level === 'authNoPriv') {
    return {
      version: '3',
      username: row.username,
      securityLevel: row.security_level,
      authProtocol: row.auth_protocol,
      authPassword: secret.authPassword ?? '',
    }
  }
  if (!row.privacy_protocol) {
    throw new Error(`SNMPv3 credential ${row.name} has no privacy protocol`)
  }
  return {
    version: '3',
    username: row.username,
    securityLevel: row.security_level,
    authProtocol: row.auth_protocol,
    authPassword: secret.authPassword ?? '',
    privacyProtocol: row.privacy_protocol,
    privacyPassword: secret.privacyPassword ?? '',
  }
}

export class TelegrafReconciliationService {
  private operation: Promise<void> = Promise.resolve()
  private readonly configCrypto: CollectorConfigCrypto

  constructor(
    private readonly store: CollectorStore,
    private readonly credentialCrypto: CredentialCrypto,
    private readonly publisher: TelegrafConfigPublisher,
    private readonly audit: AuthStore,
    private readonly config: AppConfig,
  ) {
    this.configCrypto = new CollectorConfigCrypto(
      config.security.credentialKey,
      config.security.credentialKeyVersion,
    )
  }

  async listRevisions(): Promise<CollectorRevision[]> {
    return this.store.listRevisions()
  }

  async status(): Promise<TelegrafCollectorStatus> {
    const [active, health] = await Promise.all([
      this.store.activeRevision(),
      checkTcpDependency(
        this.config.dependencies.telegrafHost,
        this.config.dependencies.telegrafPort,
        { name: 'Telegraf' },
      ),
    ])
    return {
      collector: 'telegraf',
      state: health.state,
      message: health.message,
      checkedAt: health.checkedAt,
      activeRevision: active ? toCollectorRevision(active) : null,
    }
  }

  reconcile(actorUserId: string | null, signal?: AbortSignal): Promise<ReconciliationResult> {
    return this.serialized(() => this.reconcileNow(actorUserId, signal))
  }

  rollback(
    sourceRevisionId: string,
    actorUserId: string | null,
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    return this.serialized(() => this.rollbackNow(sourceRevisionId, actorUserId, signal))
  }

  private async desiredState(): Promise<TelegrafCheckDesiredState[]> {
    const assignments = await this.store.desiredTelegrafAssignments()
    return assignments.map((assignment) => {
      const secret = this.credentialCrypto.decrypt(
        assignment.credential.id,
        encryptedCredential(assignment.credential),
      )
      return {
        checkId: assignment.checkId,
        sourceId: assignment.sourceId,
        sourceName: assignment.sourceName,
        target: assignment.target,
        port: assignment.port,
        transport: assignment.transport,
        siteId: assignment.siteId,
        tags: assignment.tags,
        intervalSeconds: assignment.intervalSeconds,
        timeoutMs: assignment.timeoutMs,
        retries: assignment.retries,
        collectSystem: assignment.collectSystem,
        collectInterfaces: assignment.collectInterfaces,
        credential: telegrafCredential(assignment.credential, secret),
      }
    })
  }

  /**
   * Whether applying would change Telegraf. Renders the candidate the reconciler
   * would publish and compares its hash to the active revision, so this is the
   * same comparison the reconcile itself makes rather than a timestamp guess.
   */
  async pendingChange(): Promise<SyncProbe> {
    const active = await this.store.activeRevision()
    let rendered
    try {
      rendered = telegrafAdapter.render(await this.desiredState())
    } catch (error) {
      return {
        pending: false,
        detail: 'The desired configuration could not be rendered',
        lastAppliedAt: active?.activated_at ?? null,
        blocked: error instanceof Error ? error.message : 'Unknown error',
      }
    }

    if (active?.content_hash.trim() === rendered.contentHash) {
      return {
        pending: false,
        detail: `Revision ${active.revision_number} is current`,
        lastAppliedAt: active.activated_at,
        blocked: null,
      }
    }
    return {
      pending: true,
      detail: active
        ? `${rendered.checkCount} checks on ${rendered.sourceCount} devices differ from revision ${active.revision_number}`
        : `${rendered.checkCount} checks on ${rendered.sourceCount} devices have never been published`,
      lastAppliedAt: active?.activated_at ?? null,
      blocked: null,
    }
  }

  private async reconcileNow(
    actorUserId: string | null,
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    signal?.throwIfAborted()
    const rendered = telegrafAdapter.render(await this.desiredState())
    const active = await this.store.activeRevision()
    if (active?.content_hash.trim() === rendered.contentHash) {
      return { changed: false, revision: toCollectorRevision(active) }
    }
    return this.activate(
      {
        content: rendered.content,
        redactedContent: rendered.redactedContent,
        contentHash: rendered.contentHash,
        sourceCount: rendered.sourceCount,
        checkCount: rendered.checkCount,
        reason: 'reconcile',
        sourceRevisionId: null,
      },
      active,
      actorUserId,
      signal,
    )
  }

  private async rollbackNow(
    sourceRevisionId: string,
    actorUserId: string | null,
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    signal?.throwIfAborted()
    const source = await this.store.storedRevision(sourceRevisionId)
    if (!source || source.status === 'failed') {
      throw new Error('The selected revision is not a known-good Telegraf configuration')
    }
    const content = this.decrypt(source)
    telegrafAdapter.validate(content, source.check_count)
    return this.activate(
      {
        content,
        redactedContent: source.rendered_config,
        contentHash: source.content_hash.trim(),
        sourceCount: source.source_count,
        checkCount: source.check_count,
        reason: 'rollback',
        sourceRevisionId: source.id,
      },
      await this.store.activeRevision(),
      actorUserId,
      signal,
    )
  }

  private async activate(
    candidate: {
      content: string
      redactedContent: string
      contentHash: string
      sourceCount: number
      checkCount: number
      reason: 'reconcile' | 'rollback'
      sourceRevisionId: string | null
    },
    previous: StoredCollectorRevision | null,
    actorUserId: string | null,
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    const id = randomUUID()
    const encrypted = this.configCrypto.encrypt(id, candidate.content)
    await this.store.createPendingRevision({
      id,
      reason: candidate.reason,
      sourceRevisionId: candidate.sourceRevisionId,
      contentHash: candidate.contentHash,
      renderedConfig: candidate.redactedContent,
      encrypted,
      sourceCount: candidate.sourceCount,
      checkCount: candidate.checkCount,
      createdBy: actorUserId,
    })

    try {
      signal?.throwIfAborted()
      await this.publisher.publish(id, candidate.content)
      try {
        signal?.throwIfAborted()
        await this.store.activate(id)
      } catch (error) {
        if (previous) await this.publisher.restore(this.decrypt(previous))
        else await this.publisher.clearActive()
        throw error
      }
      await this.audit.writeAudit({
        actorUserId,
        action:
          candidate.reason === 'rollback'
            ? 'collector.telegraf.rolled_back'
            : 'collector.telegraf.reconciled',
        resourceType: 'collector_revision',
        resourceId: id,
        outcome: 'success',
        metadata: {
          contentHash: candidate.contentHash,
          sourceCount: candidate.sourceCount,
          checkCount: candidate.checkCount,
          sourceRevisionId: candidate.sourceRevisionId,
        },
      })
      return {
        changed: true,
        revision: toCollectorRevision((await this.store.storedRevision(id))!),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Collector activation failed'
      await this.store.fail(id, message)
      await this.audit.writeAudit({
        actorUserId,
        action: 'collector.telegraf.reconciliation_failed',
        resourceType: 'collector_revision',
        resourceId: id,
        outcome: 'failure',
        metadata: { reason: candidate.reason },
      })
      throw error
    }
  }

  private decrypt(revision: StoredCollectorRevision): string {
    return this.configCrypto.decrypt(revision.id, {
      keyVersion: revision.config_key_version,
      nonce: revision.config_nonce,
      ciphertext: revision.config_ciphertext,
      authTag: revision.config_auth_tag,
    })
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
