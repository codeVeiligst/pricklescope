import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table collector_revisions (
      id uuid primary key,
      revision_number integer generated always as identity unique,
      collector varchar(32) not null check (collector in ('telegraf')),
      status varchar(16) not null check (status in ('active', 'superseded', 'failed')),
      reason varchar(16) not null check (reason in ('reconcile', 'rollback')),
      source_revision_id uuid references collector_revisions(id) on delete set null,
      content_hash char(64) not null,
      rendered_config text not null,
      config_key_version integer not null,
      config_nonce bytea not null,
      config_ciphertext bytea not null,
      config_auth_tag bytea not null,
      source_count integer not null check (source_count >= 0),
      check_count integer not null check (check_count >= 0),
      error text,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      activated_at timestamptz
    )
  `.execute(db)
  await sql`
    create unique index collector_revisions_one_active_idx
      on collector_revisions (collector) where status = 'active'
  `.execute(db)
  await sql`
    create index collector_revisions_history_idx
      on collector_revisions (collector, revision_number desc)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists collector_revisions`.execute(db)
}
