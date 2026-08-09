import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table contact_points
      -- Which service sends the mail. Null for a plain webhook contact point.
      add column provider text check (
        provider in ('graph', 'gmail', 'sendgrid', 'mailgun', 'postmark', 'nylas')
      ),
      -- Non-secret provider settings: tenant, domain, region, grant, sender.
      add column provider_config jsonb not null default '{}'::jsonb,
      -- Public reference Grafana calls back on; the bearer token stays encrypted
      -- alongside the provider credentials.
      add column delivery_ref uuid not null default gen_random_uuid(),
      add column last_delivery_at timestamptz,
      add column last_delivery_ok boolean,
      add column last_delivery_error text
  `.execute(db)
  await sql`
    create unique index contact_points_delivery_ref_idx on contact_points (delivery_ref)
  `.execute(db)
  await sql`
    alter table contact_points
      drop constraint contact_points_kind_check
  `.execute(db)
  await sql`
    alter table contact_points
      add constraint contact_points_kind_check check (kind in ('webhook', 'email'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table contact_points
      drop column if exists provider,
      drop column if exists provider_config,
      drop column if exists delivery_ref,
      drop column if exists last_delivery_at,
      drop column if exists last_delivery_ok,
      drop column if exists last_delivery_error
  `.execute(db)
}
