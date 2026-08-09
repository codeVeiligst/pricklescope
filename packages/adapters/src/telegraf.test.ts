import { describe, expect, it } from 'vitest'

import {
  renderTelegrafConfig,
  telegrafAdapter,
  validateTelegrafCandidate,
  type TelegrafCheckDesiredState,
} from './telegraf.js'

const base: TelegrafCheckDesiredState = {
  checkId: '10000000-0000-4000-8000-000000000001',
  sourceId: '20000000-0000-4000-8000-000000000001',
  sourceName: 'Core router',
  target: '192.0.2.1',
  port: 161,
  transport: 'udp4',
  siteId: null,
  tags: ['core', 'router'],
  intervalSeconds: 60,
  timeoutMs: 3000,
  retries: 1,
  collectSystem: true,
  collectInterfaces: true,
  credential: { version: '2c', community: 'private-community' },
}

describe('Telegraf adapter', () => {
  it('renders deterministic SNMP and unprivileged ping configuration', () => {
    const rendered = renderTelegrafConfig([base])
    expect(rendered.content).toContain('[[inputs.snmp]]')
    expect(rendered.content).toContain('[[inputs.ping]]')
    expect(rendered.content).toContain('method = "exec"')
    expect(rendered.content).toContain('name = "network_system"')
    expect(rendered.content).toContain('name = "network_interface"')
    expect(rendered.content).toContain('name = "if_in_octets"')
    expect(rendered.content).toContain('name = "if_counter_discontinuity_time"')
    expect(rendered.content).toContain('[[processors.starlark]]')
    expect(rendered.content).toContain('[[processors.converter]]')
    expect(rendered.contentHash).toHaveLength(64)
    expect(renderTelegrafConfig([base]).contentHash).toBe(rendered.contentHash)
  })

  it('keeps secrets out of the preview while retaining usable configuration', () => {
    const rendered = renderTelegrafConfig([base])
    expect(rendered.content).toContain('private-community')
    expect(rendered.redactedContent).not.toContain('private-community')
    expect(rendered.redactedContent).toContain('[REDACTED]')
  })

  it('supports complete SNMPv3 authPriv credentials and IPv6 targets', () => {
    const rendered = renderTelegrafConfig([
      {
        ...base,
        target: '2001:db8::10',
        transport: 'udp6',
        credential: {
          version: '3',
          username: 'monitor',
          securityLevel: 'authPriv',
          authProtocol: 'sha256',
          authPassword: 'authentication-passphrase',
          privacyProtocol: 'aes',
          privacyPassword: 'privacy-passphrase',
        },
      },
    ])
    expect(rendered.content).toContain('udp://[2001:db8::10]:161')
    expect(rendered.content).toContain('auth_protocol = "SHA256"')
    expect(rendered.redactedContent).not.toContain('passphrase')
  })

  it('rejects incomplete desired state before rendering', () => {
    expect(() =>
      renderTelegrafConfig([{ ...base, credential: { version: '2c', community: '' } }]),
    ).toThrow('community is missing')
    expect(() =>
      renderTelegrafConfig([{ ...base, collectSystem: false, collectInterfaces: false }]),
    ).toThrow('No SNMP metric groups')
  })

  it('rejects a structurally incomplete or redacted activation candidate', () => {
    expect(telegrafAdapter.kind).toBe('telegraf')
    expect(() => validateTelegrafCandidate('[[inputs.snmp]]\n', 1)).toThrow('desired check count')
    expect(() =>
      validateTelegrafCandidate('[[inputs.snmp]]\ncommunity = "[REDACTED]"\n[[inputs.ping]]\n', 1),
    ).toThrow('redacted secret')
  })
})
