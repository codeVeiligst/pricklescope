import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table contact_points (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      kind text not null check (kind in ('webhook', 'email')),
      -- Webhook target. Email needs an SMTP relay Grafana can reach, which not
      -- every deployment has, so webhook is the supported default (D-022).
      url text,
      addresses text,
      -- Optional shared secret sent as a bearer token, encrypted at rest.
      secret_key_version integer,
      secret_nonce bytea,
      secret_ciphertext bytea,
      secret_auth_tag bytea,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index contact_points_name_lower_idx on contact_points (lower(name))`.execute(
    db,
  )

  await sql`
    create table alert_rules (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      description text,
      enabled boolean not null default true,
      -- Scope. A rule without a source watches every reporting source.
      source_id uuid references sources(id) on delete cascade,
      if_index text,
      metric text not null check (
        metric in ('availability', 'latency', 'inbound_bps', 'outbound_bps', 'interface_errors')
      ),
      reducer text not null check (reducer in ('last', 'avg', 'min', 'max')),
      comparison text not null check (comparison in ('gt', 'lt')),
      threshold double precision not null,
      -- Optional hysteresis: the rule only clears once it passes this instead of
      -- the firing threshold, so a value hovering on the line does not flap.
      recovery_threshold double precision,
      evaluation_interval_seconds integer not null default 60
        check (evaluation_interval_seconds between 10 and 3600),
      pending_seconds integer not null default 300
        check (pending_seconds between 0 and 86400),
      lookback_seconds integer not null default 600
        check (lookback_seconds between 60 and 86400),
      no_data_state text not null default 'NoData'
        check (no_data_state in ('NoData', 'Alerting', 'OK', 'KeepLast')),
      exec_error_state text not null default 'Error'
        check (exec_error_state in ('Error', 'Alerting', 'OK', 'KeepLast')),
      severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
      contact_point_id uuid references contact_points(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index alert_rules_name_lower_idx on alert_rules (lower(name))`.execute(db)
  await sql`create index alert_rules_source_idx on alert_rules (source_id)`.execute(db)

  // Alert rules and contact points join the reconciled resource inventory.
  await sql`
    alter table managed_grafana_resources
      drop constraint managed_grafana_resources_resource_type_check
  `.execute(db)
  await sql`
    alter table managed_grafana_resources
      add constraint managed_grafana_resources_resource_type_check
      check (
        resource_type in ('datasource', 'folder', 'dashboard', 'alert_rule', 'contact_point')
      )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists alert_rules`.execute(db)
  await sql`drop table if exists contact_points`.execute(db)
}
