create extension if not exists "pgcrypto";

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null,
  address text,
  capacity int,
  created_at timestamptz default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete set null,
  title text not null,
  description text,
  event_date timestamptz not null,
  image_url text,
  status text check (status in ('draft', 'published', 'cancelled')) default 'draft',
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.event_seats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  seat_label text not null,
  section text,
  price numeric(10,2) not null,
  status text check (status in ('available', 'reserved', 'sold')) default 'available',
  created_at timestamptz default now(),
  unique (event_id, seat_label)
);

create index events_venue_id_idx on public.events (venue_id);
create index events_status_event_date_idx on public.events (status, event_date);
create index events_created_by_idx on public.events (created_by);
create index event_seats_event_id_idx on public.event_seats (event_id);
create index event_seats_event_status_idx on public.event_seats (event_id, status);

-- Authorization for published reads and admin writes is enforced in the Events Service API layer.
