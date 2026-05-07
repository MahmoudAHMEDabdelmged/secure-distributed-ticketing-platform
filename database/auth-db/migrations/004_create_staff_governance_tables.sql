begin;

create extension if not exists "pgcrypto";

alter table public.users
  add column if not exists role varchar(50);

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.users'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.users drop constraint if exists %I', constraint_name);
  end loop;
end;
$$;

update public.users
set role = 'regular_employee'
where role = 'organizer';

update public.users
set role = 'user'
where role is null
   or role not in ('user', 'regular_employee', 'gate_staff', 'admin', 'security_staff', 'security_leader');

alter table public.users
  alter column role type varchar(50) using role::varchar(50),
  alter column role set default 'user',
  alter column role set not null;

alter table public.users
  add column if not exists staff_status varchar(50) not null default 'active',
  add column if not exists must_reset_password boolean not null default false,
  add column if not exists created_by_user_id uuid null,
  add column if not exists activated_at timestamptz null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.users'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%staff_status%'
  loop
    execute format('alter table public.users drop constraint if exists %I', constraint_name);
  end loop;
end;
$$;

update public.users
set staff_status = 'active'
where staff_status is null
   or staff_status not in ('active', 'pending_approval', 'rejected', 'disabled');

alter table public.users
  alter column staff_status type varchar(50) using staff_status::varchar(50),
  alter column staff_status set default 'active',
  alter column staff_status set not null;

alter table public.users
  add constraint users_role_check
  check (role in ('user', 'regular_employee', 'gate_staff', 'admin', 'security_staff', 'security_leader'));

alter table public.users
  add constraint users_staff_status_check
  check (staff_status in ('active', 'pending_approval', 'rejected', 'disabled'));

create index if not exists users_staff_status_idx on public.users (staff_status);
create index if not exists users_created_by_user_id_idx on public.users (created_by_user_id);
create index if not exists users_activated_at_idx on public.users (activated_at);

create table if not exists public.staff_onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  target_email varchar(255) not null,
  target_full_name varchar(255),
  target_role varchar(50) not null,
  status varchar(50) not null default 'pending',
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  target_user_id uuid references public.users(id) on delete set null,
  required_approvals integer not null,
  approval_policy varchar(100) not null,
  approval_count integer not null default 0,
  leader_override boolean not null default false,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  activated_at timestamptz,
  constraint staff_onboarding_requests_target_role_check
    check (target_role in ('regular_employee', 'gate_staff', 'admin', 'security_staff')),
  constraint staff_onboarding_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'activated', 'cancelled')),
  constraint staff_onboarding_requests_approval_policy_check
    check (approval_policy in ('security_two_person', 'security_four_person_or_leader', 'regular_employee_two_person')),
  constraint staff_onboarding_requests_required_approvals_check
    check (required_approvals > 0),
  constraint staff_onboarding_requests_approval_count_check
    check (approval_count >= 0)
);

create table if not exists public.staff_onboarding_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.staff_onboarding_requests(id) on delete cascade,
  approver_user_id uuid not null references public.users(id) on delete restrict,
  approver_role varchar(50) not null,
  decision varchar(50) not null,
  is_leader_override boolean not null default false,
  comment text,
  created_at timestamptz not null default now(),
  constraint staff_onboarding_approvals_approver_role_check
    check (approver_role in ('regular_employee', 'gate_staff', 'admin', 'security_staff', 'security_leader')),
  constraint staff_onboarding_approvals_decision_check
    check (decision in ('approved', 'rejected')),
  constraint staff_onboarding_approvals_request_approver_key
    unique (request_id, approver_user_id)
);

create index if not exists staff_onboarding_requests_status_idx
  on public.staff_onboarding_requests (status);
create index if not exists staff_onboarding_requests_target_role_idx
  on public.staff_onboarding_requests (target_role);
create index if not exists staff_onboarding_requests_requested_by_user_id_idx
  on public.staff_onboarding_requests (requested_by_user_id);
create index if not exists staff_onboarding_requests_target_user_id_idx
  on public.staff_onboarding_requests (target_user_id);
create index if not exists staff_onboarding_requests_created_at_idx
  on public.staff_onboarding_requests (created_at);
create index if not exists staff_onboarding_requests_target_email_idx
  on public.staff_onboarding_requests (target_email);

create index if not exists staff_onboarding_approvals_request_id_idx
  on public.staff_onboarding_approvals (request_id);
create index if not exists staff_onboarding_approvals_approver_user_id_idx
  on public.staff_onboarding_approvals (approver_user_id);
create index if not exists staff_onboarding_approvals_decision_idx
  on public.staff_onboarding_approvals (decision);

create or replace function public.set_staff_onboarding_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_staff_onboarding_requests_updated_at on public.staff_onboarding_requests;

create trigger set_staff_onboarding_requests_updated_at
before update on public.staff_onboarding_requests
for each row
execute function public.set_staff_onboarding_requests_updated_at();

commit;
