import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table grafana_settings (
      settings_key varchar(32) primary key,
      status varchar(16) not null check (status in ('unconfigured', 'pending', 'active', 'failed')),
      error text,
      revision integer not null default 1,
      service_account_id bigint,
      service_account_token_id bigint,
      token_key_version integer,
      token_nonce bytea,
      token_ciphertext bytea,
      token_auth_tag bytea,
      grafana_version varchar(64),
      plugin_version varchar(64),
      updated_by uuid references users(id) on delete set null,
      updated_at timestamptz not null default now(),
      applied_at timestamptz,
      check (
        (token_key_version is null and token_nonce is null and token_ciphertext is null and token_auth_tag is null)
        or
        (token_key_version is not null and token_nonce is not null and token_ciphertext is not null and token_auth_tag is not null)
      )
    )
  `.execute(db)
  await sql`
    insert into grafana_settings (settings_key, status)
      values ('primary', 'unconfigured')
  `.execute(db)

  await sql`
    create table managed_grafana_resources (
      uid varchar(128) primary key,
      resource_type varchar(32) not null check (resource_type in ('datasource', 'folder', 'dashboard')),
      title varchar(256) not null,
      folder_uid varchar(128),
      content_hash char(64) not null,
      revision integer not null default 1,
      status varchar(16) not null check (status in ('active', 'failed')),
      error text,
      reconciled_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`
    create index managed_grafana_resources_type_idx
      on managed_grafana_resources (resource_type, title)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists managed_grafana_resources`.execute(db)
  await sql`drop table if exists grafana_settings`.execute(db)
}
