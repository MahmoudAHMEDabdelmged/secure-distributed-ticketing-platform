create extension if not exists "pgcrypto";

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_id uuid not null,
  seat_id uuid not null,
  status text check (status in ('reserved', 'confirmed', 'expired', 'cancelled')) default 'reserved',
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.reservations enable row level security;

create policy "Users can view their own reservations"
on public.reservations
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Users can create reservations for themselves"
on public.reservations
for insert
to authenticated
with check (user_id = auth.uid());

create policy "Admins can update all reservations"
on public.reservations
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
