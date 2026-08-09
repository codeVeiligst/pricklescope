import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sites
      add column parent_id uuid references sites(id) on delete restrict
  `.execute(db)
  await sql`drop index sites_name_lower_idx`.execute(db)
  await sql`
    create unique index sites_parent_name_lower_idx
      on sites (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  `.execute(db)
  await sql`create index sites_parent_idx on sites (parent_id, name)`.execute(db)
  await sql`
    create function prevent_site_cycle() returns trigger as $$
    begin
      if new.parent_id is null then
        return new;
      end if;

      if new.parent_id = new.id or exists (
        with recursive ancestors as (
          select id, parent_id from sites where id = new.parent_id
          union all
          select site.id, site.parent_id
          from sites site
          join ancestors ancestor on site.id = ancestor.parent_id
        )
        select 1 from ancestors where id = new.id
      ) then
        raise exception 'A site cannot be its own ancestor' using errcode = '23514';
      end if;

      return new;
    end;
    $$ language plpgsql
  `.execute(db)
  await sql`
    create trigger sites_prevent_cycle
      before insert or update of parent_id on sites
      for each row execute function prevent_site_cycle()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists sites_prevent_cycle on sites`.execute(db)
  await sql`drop function if exists prevent_site_cycle()`.execute(db)
  await sql`drop index if exists sites_parent_idx`.execute(db)
  await sql`drop index if exists sites_parent_name_lower_idx`.execute(db)
  await sql`alter table sites drop column if exists parent_id`.execute(db)
  await sql`create unique index sites_name_lower_idx on sites (lower(name))`.execute(db)
}
