create extension if not exists "pgcrypto";

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

-- Reservation authorization is enforced in the Booking Service API layer.
