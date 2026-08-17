create table if not exists zoom_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  zoom_user_id text not null,
  zoom_email text,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  token_expiry timestamptz not null,
  connected_at timestamptz not null default now(),
  unique (tenant_id)
);

alter table zoom_connections enable row level security;

create policy "owner can access own zoom_connections"
  on zoom_connections
  for all
  using (
    tenant_id in (
      select id
      from tenants
      where owner_user_id = auth.uid()
    )
  );