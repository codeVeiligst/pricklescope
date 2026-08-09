import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table oidc_provider_settings (
      provider_key varchar(64) primary key,
      enabled boolean not null default false,
      name varchar(128) not null,
      issuer_url text,
      client_id varchar(512),
      client_secret_key_version integer,
      client_secret_nonce bytea,
      client_secret_ciphertext bytea,
      client_secret_auth_tag bytea,
      redirect_uri text not null,
      scopes text not null,
      jit_provisioning boolean not null default true,
      admin_group varchar(512),
      operator_group varchar(512),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by uuid references users(id) on delete set null,
      check (
        (
          client_secret_key_version is null and client_secret_nonce is null and
          client_secret_ciphertext is null and client_secret_auth_tag is null
        ) or (
          client_secret_key_version is not null and client_secret_nonce is not null and
          client_secret_ciphertext is not null and client_secret_auth_tag is not null
        )
      )
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists oidc_provider_settings`.execute(db)
}
