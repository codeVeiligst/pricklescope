// Email delivery for alert notifications. Grafana evaluates and routes, but the
// controller sends the mail (D-023), because the providers people actually use
// cannot all be driven from a generic JSON webhook: Gmail wants a base64url MIME
// blob and Mailgun wants form encoding.
//
// Each adapter turns one plain message into one provider request. Everything an
// operator sees is in their own words — the OAuth exchanges, MIME assembly, and
// encoding live here and are never surfaced.

import { EMAIL_PROVIDER_FIELDS, type EmailProvider } from '@pricklescope/contracts'

export { EMAIL_PROVIDER_FIELDS }

export type EmailProviderId = EmailProvider

export interface EmailMessage {
  from: string
  to: string[]
  subject: string
  text: string
}

/** Non-secret settings. Base URLs are overridable so tests can assert requests. */
export interface EmailProviderConfig {
  provider: EmailProviderId
  from: string
  tenantId?: string
  domain?: string
  region?: 'us' | 'eu'
  grantId?: string
  apiBaseUrl?: string
  tokenBaseUrl?: string
}

/** Write-only, encrypted at rest, never returned by the API. */
export interface EmailCredentials {
  apiKey?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
}

export class EmailDeliveryError extends Error {
  constructor(
    readonly provider: EmailProviderId,
    message: string,
  ) {
    super(message)
    this.name = 'EmailDeliveryError'
  }
}

function required<T>(value: T | undefined | null, provider: EmailProviderId, label: string): T {
  if (value === undefined || value === null || value === '') {
    throw new EmailDeliveryError(provider, `${label} is required for this provider`)
  }
  return value
}

async function expectOk(response: Response, provider: EmailProviderId): Promise<void> {
  if (response.ok) return
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 300)
  } catch {
    // The status alone is still useful to the operator.
  }
  throw new EmailDeliveryError(
    provider,
    `The provider rejected the message (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
  )
}

/** RFC 2822 message, base64url encoded, which is the only form Gmail accepts. */
function encodeMime(message: EmailMessage): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ]
  const raw = `${headers.join('\r\n')}\r\n\r\n${message.text}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

async function oauthToken(
  tokenUrl: string,
  body: Record<string, string>,
  provider: EmailProviderId,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  await expectOk(response, provider)
  const token = (await response.json()) as { access_token?: string }
  if (!token.access_token) {
    throw new EmailDeliveryError(provider, 'The sign-in response contained no access token')
  }
  return token.access_token
}

export async function sendEmail(
  message: EmailMessage,
  config: EmailProviderConfig,
  credentials: EmailCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const provider = config.provider
  const timeout = () => AbortSignal.timeout(20_000)

  switch (provider) {
    case 'graph': {
      const tenant = required(config.tenantId, provider, 'Directory (tenant) ID')
      const tokenBase = config.tokenBaseUrl ?? 'https://login.microsoftonline.com'
      const token = await oauthToken(
        `${tokenBase}/${tenant}/oauth2/v2.0/token`,
        {
          client_id: required(credentials.clientId, provider, 'Application (client) ID'),
          client_secret: required(credentials.clientSecret, provider, 'Client secret'),
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        },
        provider,
        fetchImpl,
      )
      const base = config.apiBaseUrl ?? 'https://graph.microsoft.com'
      const response = await fetchImpl(
        `${base}/v1.0/users/${encodeURIComponent(message.from)}/sendMail`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject: message.subject,
              body: { contentType: 'Text', content: message.text },
              toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: false,
          }),
          signal: timeout(),
        },
      )
      return expectOk(response, provider)
    }

    case 'gmail': {
      const tokenBase = config.tokenBaseUrl ?? 'https://oauth2.googleapis.com'
      const token = await oauthToken(
        `${tokenBase}/token`,
        {
          client_id: required(credentials.clientId, provider, 'OAuth client ID'),
          client_secret: required(credentials.clientSecret, provider, 'OAuth client secret'),
          refresh_token: required(credentials.refreshToken, provider, 'Refresh token'),
          grant_type: 'refresh_token',
        },
        provider,
        fetchImpl,
      )
      const base = config.apiBaseUrl ?? 'https://gmail.googleapis.com'
      const response = await fetchImpl(`${base}/gmail/v1/users/me/messages/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: encodeMime(message) }),
        signal: timeout(),
      })
      return expectOk(response, provider)
    }

    case 'sendgrid': {
      const base = config.apiBaseUrl ?? 'https://api.sendgrid.com'
      const response = await fetchImpl(`${base}/v3/mail/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${required(credentials.apiKey, provider, 'API key')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: message.to.map((address) => ({ email: address })) }],
          from: { email: message.from },
          subject: message.subject,
          content: [{ type: 'text/plain', value: message.text }],
        }),
        signal: timeout(),
      })
      return expectOk(response, provider)
    }

    case 'mailgun': {
      // Form encoded, not JSON: Mailgun's send endpoint takes no JSON body.
      const domain = required(config.domain, provider, 'Sending domain')
      const base =
        config.apiBaseUrl ??
        (config.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net')
      const form = new URLSearchParams({
        from: message.from,
        subject: message.subject,
        text: message.text,
      })
      for (const address of message.to) form.append('to', address)
      const key = required(credentials.apiKey, provider, 'API key')
      const response = await fetchImpl(`${base}/v3/${domain}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: timeout(),
      })
      return expectOk(response, provider)
    }

    case 'postmark': {
      const base = config.apiBaseUrl ?? 'https://api.postmarkapp.com'
      const response = await fetchImpl(`${base}/email`, {
        method: 'POST',
        headers: {
          'x-postmark-server-token': required(credentials.apiKey, provider, 'Server token'),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to.join(', '),
          Subject: message.subject,
          TextBody: message.text,
          MessageStream: 'outbound',
        }),
        signal: timeout(),
      })
      return expectOk(response, provider)
    }

    case 'nylas': {
      const base = config.apiBaseUrl ?? 'https://api.us.nylas.com'
      const grant = required(config.grantId, provider, 'Grant ID')
      const response = await fetchImpl(`${base}/v3/grants/${grant}/messages/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${required(credentials.apiKey, provider, 'API key')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          subject: message.subject,
          body: message.text,
          from: [{ email: message.from }],
          to: message.to.map((address) => ({ email: address })),
        }),
        signal: timeout(),
      })
      return expectOk(response, provider)
    }
  }
}
