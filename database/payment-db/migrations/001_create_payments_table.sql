create extension if not exists "pgcrypto";

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null,
  user_id uuid not null,
  amount numeric(10,2) not null,
  status text check (status in ('pending', 'success', 'failed')) default 'pending',
  fake_transaction_reference text,
  created_at timestamptz default now()
);

create index payments_reservation_id_idx on public.payments (reservation_id);
create index payments_user_id_idx on public.payments (user_id);
create index payments_status_idx on public.payments (status);

alter table public.payments enable row level security;

create policy "Users can view their own payments"
on public.payments
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Admins can insert payments"
on public.payments
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update payments"
on public.payments
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
