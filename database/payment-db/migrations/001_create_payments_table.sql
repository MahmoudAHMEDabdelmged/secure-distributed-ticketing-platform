create extension if not exists "pgcrypto";

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

-- Payment authorization is enforced in the Payment Service API layer.
