begin;

create extension if not exists "pgcrypto";

-- Phase 4 replaces the earlier sample events schema with dynamic service-owned tables.
drop table if exists public.event_sections cascade;
drop table if exists public.event_seats cascade;
drop table if exists public.events cascade;
drop table if exists public.venues cascade;

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null,
  country text not null,
  address text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete set null,
  title text not null,
  description text,
  category text not null default 'general',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'published',
  image_url text,
  created_by_user_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint events_status_check check (status in ('draft', 'published', 'cancelled', 'completed')),
  constraint events_ends_after_starts_check check (ends_at > starts_at)
);

create table public.event_sections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  currency varchar(3) default 'EGP',
  total_capacity integer not null check (total_capacity > 0),
  available_capacity integer not null check (available_capacity >= 0),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint event_sections_available_not_over_total_check check (available_capacity <= total_capacity),
  constraint event_sections_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint event_sections_event_id_name_key unique (event_id, name)
);

create index events_status_idx on public.events (status);
create index events_starts_at_idx on public.events (starts_at);
create index events_category_idx on public.events (category);
create index events_venue_id_idx on public.events (venue_id);
create index event_sections_event_id_idx on public.event_sections (event_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger venues_set_updated_at
before update on public.venues
for each row
execute function public.set_updated_at();

create trigger events_set_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

create trigger event_sections_set_updated_at
before update on public.event_sections
for each row
execute function public.set_updated_at();

commit;
