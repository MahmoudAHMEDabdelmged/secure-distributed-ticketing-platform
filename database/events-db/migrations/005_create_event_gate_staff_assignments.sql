begin;

create extension if not exists "pgcrypto";

create table if not exists public.event_gate_staff_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  staff_user_id uuid not null,
  assigned_by_user_id uuid,
  gate_code_hash text not null,
  gate_code_encrypted text,
  gate_code_iv text,
  gate_code_auth_tag text,
  code_hint varchar,
  code_active_from timestamptz not null,
  code_expires_at timestamptz not null,
  status varchar not null default 'assigned',
  failed_attempts int not null default 0,
  last_used_at timestamptz,
  last_failed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_gate_staff_assignments_window_check
    check (code_expires_at > code_active_from),
  constraint event_gate_staff_assignments_status_check
    check (status in ('assigned', 'active', 'revoked', 'expired')),
  constraint event_gate_staff_assignments_event_staff_key
    unique (event_id, staff_user_id),
  constraint event_gate_staff_assignments_gate_code_hash_key
    unique (gate_code_hash)
);

create index if not exists event_gate_staff_assignments_event_id_idx
  on public.event_gate_staff_assignments (event_id);
create index if not exists event_gate_staff_assignments_staff_user_id_idx
  on public.event_gate_staff_assignments (staff_user_id);
create index if not exists event_gate_staff_assignments_status_idx
  on public.event_gate_staff_assignments (status);
create index if not exists event_gate_staff_assignments_code_active_from_idx
  on public.event_gate_staff_assignments (code_active_from);
create index if not exists event_gate_staff_assignments_code_expires_at_idx
  on public.event_gate_staff_assignments (code_expires_at);
create index if not exists event_gate_staff_assignments_created_at_idx
  on public.event_gate_staff_assignments (created_at);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists event_gate_staff_assignments_set_updated_at
  on public.event_gate_staff_assignments;

create trigger event_gate_staff_assignments_set_updated_at
before update on public.event_gate_staff_assignments
for each row
execute function public.set_updated_at();

commit;
