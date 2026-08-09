import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      id uuid primary key,
      username varchar(128) not null,
      username_normalized varchar(128) not null unique,
      display_name varchar(256) not null,
      email varchar(320),
      role varchar(32) not null check (role in ('viewer', 'operator', 'administrator')),
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_login_at timestamptz
    )
  `.execute(db)

  await sql`
    create table local_credentials (
      user_id uuid primary key references users(id) on delete cascade,
      password_hash text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)

  await sql`
    create table oidc_identities (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      issuer text not null,
      subject text not null,
      email varchar(320),
      claims jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (issuer, subject)
    )
  `.execute(db)

  await sql`
    create table sessions (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      token_hash char(64) not null unique,
      csrf_token varchar(128) not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index sessions_expires_at_idx on sessions (expires_at)`.execute(db)

  await sql`
    create table oidc_login_flows (
      id uuid primary key,
      flow_token_hash char(64) not null unique,
      state varchar(256) not null,
      code_verifier varchar(256) not null,
      nonce varchar(256) not null,
      return_to text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index oidc_login_flows_expires_at_idx on oidc_login_flows (expires_at)`.execute(
    db,
  )

  await sql`
    create table jobs (
      id uuid primary key,
      type varchar(128) not null,
      status varchar(32) not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      payload jsonb not null default '{}'::jsonb,
      result jsonb,
      error text,
      progress integer not null default 0 check (progress between 0 and 100),
      requested_by uuid references users(id) on delete set null,
      attempts integer not null default 0,
      timeout_ms integer not null check (timeout_ms between 1000 and 3600000),
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      heartbeat_at timestamptz
    )
  `.execute(db)
  await sql`create index jobs_claim_idx on jobs (status, created_at)`.execute(db)

  await sql`
    create table desired_state (
      key varchar(256) primary key,
      value jsonb not null,
      revision bigint not null default 1,
      updated_by uuid references users(id) on delete set null,
      updated_at timestamptz not null default now()
    )
  `.execute(db)

  await sql`
    create table audit_events (
      id bigint generated always as identity primary key,
      actor_user_id uuid references users(id) on delete set null,
      action varchar(128) not null,
      resource_type varchar(128) not null,
      resource_id text,
      outcome varchar(16) not null check (outcome in ('success', 'failure')),
      metadata jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index audit_events_occurred_at_idx on audit_events (occurred_at desc)`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists audit_events`.execute(db)
  await sql`drop table if exists desired_state`.execute(db)
  await sql`drop table if exists jobs`.execute(db)
  await sql`drop table if exists oidc_login_flows`.execute(db)
  await sql`drop table if exists sessions`.execute(db)
  await sql`drop table if exists oidc_identities`.execute(db)
  await sql`drop table if exists local_credentials`.execute(db)
  await sql`drop table if exists users`.execute(db)
}
