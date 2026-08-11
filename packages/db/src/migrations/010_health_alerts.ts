import { sql, type Kysely } from 'kysely'

/**
 * The controller's built-in health alerts (D-042).
 *
 * Two tables rather than one, because they answer different questions. The
 * contact point is a single shared value: the screen offers one selector, and a
 * per-rule column would let the database hold five destinations that no surface
 * can show or set. Splitting it later is a column and a backfill.
 *
 * The rows are seeded here rather than created on demand, so a fresh
 * installation is watching itself before anyone visits a settings screen. That
 * is the entire point — the failure being fixed is that a collector could stop
 * writing and only someone looking would find out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table health_alert_settings (
      settings_key varchar(32) primary key,
      contact_point_id uuid references contact_points(id) on delete set null,
      updated_by uuid references users(id) on delete set null,
      updated_at timestamptz not null default now()
    )
  `.execute(db)
  await sql`insert into health_alert_settings (settings_key) values ('primary')`.execute(db)

  await sql`
    create table health_alert_rules (
      alert_key varchar(48) primary key,
      enabled boolean not null default true,
      threshold double precision not null,
      for_seconds integer not null check (for_seconds between 0 and 86400),
      updated_at timestamptz not null default now()
    )
  `.execute(db)

  // Defaults chosen to be quiet enough to leave on. A collector writes every ten
  // seconds, so five minutes of silence is thirty missed writes rather than a
  // blip; a dependency has to stay down for two minutes to count, which is
  // longer than a container restart.
  await sql`
    insert into health_alert_rules (alert_key, threshold, for_seconds) values
      ('collector_silent', 1, 300),
      ('collector_write_errors', 0, 600),
      ('collector_buffer', 80, 300),
      ('dependency_down', 0, 120),
      ('source_silent', 900, 300)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists health_alert_rules`.execute(db)
  await sql`drop table if exists health_alert_settings`.execute(db)
}
