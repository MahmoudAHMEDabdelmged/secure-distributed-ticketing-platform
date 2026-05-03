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
  status public.event_status default 'draft',
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index events_venue_id_idx on public.events (venue_id);
create index events_status_event_date_idx on public.events (status, event_date);
create index events_created_by_idx on public.events (created_by);
