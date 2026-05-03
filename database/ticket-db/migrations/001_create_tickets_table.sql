create extension if not exists "pgcrypto";

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_id uuid not null,
  seat_id uuid not null,
  reservation_id uuid not null,
  ticket_code text unique not null,
  qr_code_data text,
  status text check (status in ('active', 'used', 'cancelled')) default 'active',
  created_at timestamptz default now()
);

create index tickets_user_id_idx on public.tickets (user_id);
create index tickets_event_id_idx on public.tickets (event_id);
create index tickets_seat_id_idx on public.tickets (seat_id);
create index tickets_reservation_id_idx on public.tickets (reservation_id);
create index tickets_status_idx on public.tickets (status);

alter table public.tickets enable row level security;

create policy "Users can view their own tickets"
on public.tickets
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Admins can update all tickets"
on public.tickets
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
