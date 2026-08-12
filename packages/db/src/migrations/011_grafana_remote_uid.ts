import { sql, type Kysely } from 'kysely'

/**
 * Durable ownership for Grafana resources the controller creates (audit F3).
 *
 * Contact points were located, overwritten, and deleted by matching their
 * *name*. A contact point an operator created by hand with the same name was
 * therefore adopted, rewritten on the next reconcile, and deleted along with the
 * controller's own — and renaming one orphaned the previous remote resource
 * instead of updating it.
 *
 * Nullable, because installations upgrading from 0.1.2 have contact points whose
 * remote uid was never recorded. Those are adopted once, by name, and the uid is
 * written down; from then on the name is only a label.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table managed_grafana_resources add column remote_uid text`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table managed_grafana_resources drop column if exists remote_uid`.execute(db)
}
