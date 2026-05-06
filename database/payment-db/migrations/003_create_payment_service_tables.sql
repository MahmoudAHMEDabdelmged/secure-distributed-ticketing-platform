begin;

create extension if not exists "pgcrypto";

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  user_id uuid not null,
  user_email text,
  amount_cents integer not null check (amount_cents >= 0),
  currency varchar(3) not null default 'EGP',
  payment_method text not null default 'test_card',
  provider text not null default 'simulated_gateway',
  provider_payment_ref text unique not null,
  card_last4 varchar(4),
  status text not null default 'pending',
  failure_reason text,
  risk_score integer not null default 0 check (risk_score >= 0 and risk_score <= 100),
  is_suspicious boolean not null default false,
  suspicious_reason text,
  booking_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_status_check check (status in ('pending', 'succeeded', 'failed', 'suspicious', 'refunded')),
  constraint payments_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payments_card_last4_check check (card_last4 is null or card_last4 ~ '^[0-9]{4}$')
);

create index payments_booking_id_idx on public.payments (booking_id);
create index payments_user_id_idx on public.payments (user_id);
create index payments_status_idx on public.payments (status);
create index payments_is_suspicious_idx on public.payments (is_suspicious);
create index payments_created_at_idx on public.payments (created_at);
create index payments_provider_payment_ref_idx on public.payments (provider_payment_ref);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger payments_set_updated_at
before update on public.payments
for each row
execute function public.set_updated_at();

commit;
