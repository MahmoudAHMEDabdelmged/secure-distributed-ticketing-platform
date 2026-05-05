begin;

create extension if not exists "pgcrypto";

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text,
  event_id uuid not null,
  section_id uuid not null,
  event_title text not null,
  section_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_price_cents integer not null check (total_price_cents >= 0),
  currency varchar(3) not null default 'EGP',
  status text not null default 'pending',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_status_check check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  constraint bookings_currency_check check (currency ~ '^[A-Z]{3}$')
);

create index bookings_user_id_idx on public.bookings (user_id);
create index bookings_event_id_idx on public.bookings (event_id);
create index bookings_section_id_idx on public.bookings (section_id);
create index bookings_status_idx on public.bookings (status);
create index bookings_created_at_idx on public.bookings (created_at);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger bookings_set_updated_at
before update on public.bookings
for each row
execute function public.set_updated_at();

commit;
