create table public.payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references public.reservations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null,
  status public.payment_status default 'pending',
  fake_transaction_reference text,
  created_at timestamptz default now()
);

create index payments_reservation_id_idx on public.payments (reservation_id);
create index payments_user_id_idx on public.payments (user_id);
create index payments_status_idx on public.payments (status);
