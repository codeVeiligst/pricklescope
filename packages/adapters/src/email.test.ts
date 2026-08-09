import { describe, expect, it, vi } from 'vitest'

import { EMAIL_PROVIDER_FIELDS, sendEmail, type EmailProviderId } from './email.js'

const message = {
  from: 'alerts@example.test',
  to: ['ops@example.test', 'oncall@example.test'],
  subject: 'PrickleScope: Firewall availability',
  text: 'Availability fell below 99%.',
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** Records every request, answering token endpoints with an access token. */
function recorder(status = 200) {
  const calls: Captured[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const isToken = url.includes('/token')
    return new Response(isToken ? JSON.stringify({ access_token: 'tok' }) : '{}', {
      status: isToken ? 200 : status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('email providers', () => {
  it('sends Microsoft Graph mail after a client-credentials exchange', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'graph', from: message.from, tenantId: 'tenant-1' },
      { clientId: 'app', clientSecret: 'shh' },
      fetchImpl,
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/tenant-1/oauth2/v2.0/token')
    expect(calls[0]!.body).toContain('grant_type=client_credentials')
    expect(calls[0]!.body).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default')

    const send = calls[1]!
    expect(send.url).toContain('/v1.0/users/alerts%40example.test/sendMail')
    expect(send.headers.authorization).toBe('Bearer tok')
    const body = JSON.parse(send.body) as {
      message: { toRecipients: { emailAddress: { address: string } }[] }
    }
    expect(body.message.toRecipients.map((entry) => entry.emailAddress.address)).toEqual(message.to)
  })

  it('sends Gmail as a base64url MIME blob, which is the only form it accepts', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'gmail', from: message.from },
      { clientId: 'id', clientSecret: 'shh', refreshToken: 'refresh' },
      fetchImpl,
    )
    expect(calls[0]!.body).toContain('grant_type=refresh_token')

    const send = calls[1]!
    expect(send.url).toContain('/gmail/v1/users/me/messages/send')
    const { raw } = JSON.parse(send.body) as { raw: string }
    // base64url: no +, / or = padding.
    expect(raw).not.toMatch(/[+/=]/)
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('From: alerts@example.test')
    expect(decoded).toContain('To: ops@example.test, oncall@example.test')
    expect(decoded).toContain(message.subject)
    expect(decoded).toContain(message.text)
  })

  it('sends SendGrid JSON with a bearer key', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'sendgrid', from: message.from },
      { apiKey: 'sg' },
      fetchImpl,
    )
    const send = calls[0]!
    expect(send.url).toContain('/v3/mail/send')
    expect(send.headers.authorization).toBe('Bearer sg')
    const body = JSON.parse(send.body) as { personalizations: { to: { email: string }[] }[] }
    expect(body.personalizations[0]!.to.map((entry) => entry.email)).toEqual(message.to)
  })

  it('sends Mailgun form encoded, because its endpoint takes no JSON', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'mailgun', from: message.from, domain: 'mg.example.test', region: 'eu' },
      { apiKey: 'key-1' },
      fetchImpl,
    )
    const send = calls[0]!
    expect(send.url).toBe('https://api.eu.mailgun.net/v3/mg.example.test/messages')
    expect(send.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(send.headers.authorization).toBe(`Basic ${Buffer.from('api:key-1').toString('base64')}`)
    const form = new URLSearchParams(send.body)
    expect(form.getAll('to')).toEqual(message.to)
    expect(form.get('subject')).toBe(message.subject)
  })

  it('sends Postmark with its server-token header', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'postmark', from: message.from },
      { apiKey: 'pm' },
      fetchImpl,
    )
    const send = calls[0]!
    expect(send.url).toContain('/email')
    expect(send.headers['x-postmark-server-token']).toBe('pm')
    expect(JSON.parse(send.body)).toMatchObject({ To: message.to.join(', ') })
  })

  it('sends Nylas against the configured grant', async () => {
    const { calls, fetchImpl } = recorder()
    await sendEmail(
      message,
      { provider: 'nylas', from: message.from, grantId: 'grant-9' },
      { apiKey: 'ny' },
      fetchImpl,
    )
    expect(calls[0]!.url).toContain('/v3/grants/grant-9/messages/send')
    expect(calls[0]!.headers.authorization).toBe('Bearer ny')
  })

  it('reports a provider rejection in terms an operator can act on', async () => {
    const { fetchImpl } = recorder(422)
    await expect(
      sendEmail(message, { provider: 'sendgrid', from: message.from }, { apiKey: 'sg' }, fetchImpl),
    ).rejects.toThrow(/rejected the message \(HTTP 422\)/)
  })

  it('names the missing setting instead of failing obscurely', async () => {
    const { fetchImpl } = recorder()
    await expect(
      sendEmail(message, { provider: 'mailgun', from: message.from }, { apiKey: 'k' }, fetchImpl),
    ).rejects.toThrow(/Sending domain is required/)
    await expect(
      sendEmail(message, { provider: 'graph', from: message.from }, {}, fetchImpl),
    ).rejects.toThrow(/tenant\) ID is required/)
  })

  it('describes every provider so the form needs no per-provider code', () => {
    const providers: EmailProviderId[] = [
      'graph',
      'gmail',
      'sendgrid',
      'mailgun',
      'postmark',
      'nylas',
    ]
    for (const provider of providers) {
      const spec = EMAIL_PROVIDER_FIELDS[provider]
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.fields.length).toBeGreaterThan(0)
      expect(spec.fields.some((field) => field.name === 'from')).toBe(true)
    }
  })
})
