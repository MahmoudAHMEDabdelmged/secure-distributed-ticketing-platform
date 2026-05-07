begin;

create extension if not exists "pgcrypto";

create table if not exists public.event_gate_access_codes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  code_hash text not null,
  code_hint varchar(20),
  rotated_by_user_id uuid,
  status varchar(50) not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint event_gate_access_codes_status_check
    check (status in ('active', 'revoked', 'expired'))
);

create index if not exists event_gate_access_codes_event_id_idx
  on public.event_gate_access_codes (event_id);
create index if not exists event_gate_access_codes_status_idx
  on public.event_gate_access_codes (status);
create index if not exists event_gate_access_codes_created_at_idx
  on public.event_gate_access_codes (created_at);
create index if not exists event_gate_access_codes_active_lookup_idx
  on public.event_gate_access_codes (event_id, status, expires_at, created_at);
create unique index if not exists event_gate_access_codes_one_active_idx
  on public.event_gate_access_codes (event_id)
  where status = 'active';

commit;
