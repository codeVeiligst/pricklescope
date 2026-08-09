import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table storage_settings (
      settings_key varchar(32) primary key,
      raw_retention_days integer not null check (raw_retention_days between 1 and 365),
      five_minute_retention_days integer not null check (five_minute_retention_days between 30 and 3650),
      hourly_retention_days integer not null check (hourly_retention_days between 365 and 36500),
      status varchar(16) not null check (status in ('unconfigured', 'pending', 'active', 'failed')),
      error text,
      revision integer not null default 1,
      updated_by uuid references users(id) on delete set null,
      updated_at timestamptz not null default now(),
      applied_at timestamptz
    )
  `.execute(db)
  await sql`
    insert into storage_settings (
      settings_key, raw_retention_days, five_minute_retention_days,
      hourly_retention_days, status
    ) values ('primary', 30, 365, 1825, 'unconfigured')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists storage_settings`.execute(db)
}
