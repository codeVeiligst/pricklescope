import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table sites (
      id uuid primary key,
      name varchar(128) not null,
      description text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index sites_name_lower_idx on sites (lower(name))`.execute(db)

  await sql`
    create table snmp_credentials (
      id uuid primary key,
      name varchar(128) not null,
      version varchar(8) not null check (version in ('2c', '3')),
      username varchar(128),
      security_level varchar(32) check (security_level in ('noAuthNoPriv', 'authNoPriv', 'authPriv')),
      auth_protocol varchar(16) check (auth_protocol in ('sha', 'sha224', 'sha256', 'sha384', 'sha512')),
      privacy_protocol varchar(16) check (privacy_protocol in ('aes', 'aes256b', 'aes256r')),
      secret_key_version integer not null,
      secret_nonce bytea not null,
      secret_ciphertext bytea not null,
      secret_auth_tag bytea not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index snmp_credentials_name_lower_idx on snmp_credentials (lower(name))`.execute(
    db,
  )

  await sql`
    create table polling_profiles (
      id uuid primary key,
      name varchar(128) not null,
      description text,
      interval_seconds integer not null check (interval_seconds between 10 and 86400),
      timeout_ms integer not null check (timeout_ms between 250 and 60000),
      retries integer not null check (retries between 0 and 10),
      collect_system boolean not null default true,
      collect_interfaces boolean not null default true,
      check (collect_system or collect_interfaces),
      system_defined boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index polling_profiles_name_lower_idx on polling_profiles (lower(name))`.execute(
    db,
  )
  await sql`
    insert into polling_profiles (
      id, name, description, interval_seconds, timeout_ms, retries,
      collect_system, collect_interfaces, system_defined
    ) values (
      '00000000-0000-4000-8000-000000000001',
      'Generic network device',
      'System identity and IF-MIB interfaces with conservative defaults.',
      60,
      3000,
      1,
      true,
      true,
      true
    )
  `.execute(db)

  await sql`
    create table sources (
      id uuid primary key,
      site_id uuid references sites(id) on delete set null,
      name varchar(128) not null,
      target varchar(253) not null,
      port integer not null default 161 check (port between 1 and 65535),
      transport varchar(8) not null default 'udp4' check (transport in ('udp4', 'udp6')),
      enabled boolean not null default true,
      status varchar(32) not null default 'new' check (
        status in ('new', 'testing', 'reachable', 'unreachable', 'inventory_pending', 'ready')
      ),
      tags text[] not null default '{}',
      system_name text,
      system_description text,
      sys_object_id text,
      last_test_at timestamptz,
      last_test_message text,
      last_inventory_at timestamptz,
      pending_inventory_snapshot_id uuid,
      applied_inventory_snapshot_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create unique index sources_name_lower_idx on sources (lower(name))`.execute(db)
  await sql`create index sources_site_idx on sources (site_id, name)`.execute(db)
  await sql`create index sources_status_idx on sources (status)`.execute(db)

  await sql`
    create table source_checks (
      id uuid primary key,
      source_id uuid not null unique references sources(id) on delete cascade,
      credential_id uuid not null references snmp_credentials(id) on delete restrict,
      profile_id uuid not null references polling_profiles(id) on delete restrict,
      collector_selection varchar(16) not null default 'auto' check (
        collector_selection in ('auto', 'telegraf', 'alloy')
      ),
      collector_resolved varchar(16) not null check (collector_resolved in ('telegraf', 'alloy')),
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`create index source_checks_credential_idx on source_checks (credential_id)`.execute(db)
  await sql`create index source_checks_profile_idx on source_checks (profile_id)`.execute(db)

  await sql`
    create table inventory_snapshots (
      id uuid primary key,
      source_id uuid not null references sources(id) on delete cascade,
      job_id uuid unique references jobs(id) on delete set null,
      system_data jsonb not null,
      interfaces jsonb not null,
      diff jsonb not null,
      partial boolean not null default false,
      errors jsonb not null default '[]'::jsonb,
      observed_at timestamptz not null default now(),
      applied_at timestamptz,
      applied_by uuid references users(id) on delete set null
    )
  `.execute(db)
  await sql`create index inventory_snapshots_source_idx on inventory_snapshots (source_id, observed_at desc)`.execute(
    db,
  )
  await sql`
    alter table sources add constraint sources_pending_snapshot_fk
      foreign key (pending_inventory_snapshot_id) references inventory_snapshots(id) on delete set null
  `.execute(db)
  await sql`
    alter table sources add constraint sources_applied_snapshot_fk
      foreign key (applied_inventory_snapshot_id) references inventory_snapshots(id) on delete set null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sources drop constraint if exists sources_applied_snapshot_fk`.execute(db)
  await sql`alter table sources drop constraint if exists sources_pending_snapshot_fk`.execute(db)
  await sql`drop table if exists inventory_snapshots`.execute(db)
  await sql`drop table if exists source_checks`.execute(db)
  await sql`drop table if exists sources`.execute(db)
  await sql`drop table if exists polling_profiles`.execute(db)
  await sql`drop table if exists snmp_credentials`.execute(db)
  await sql`drop table if exists sites`.execute(db)
}
