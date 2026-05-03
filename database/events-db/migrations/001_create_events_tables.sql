create extension if not exists "pgcrypto";

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
    or coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'admin';
$$;

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

alter table public.venues enable row level security;
alter table public.events enable row level security;
alter table public.event_seats enable row level security;

create policy "Authenticated users can read venues for published events"
on public.venues
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.events
    where events.venue_id = venues.id
      and events.status = 'published'
  )
);

create policy "Admins can insert venues"
on public.venues
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update venues"
on public.venues
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can delete venues"
on public.venues
for delete
to authenticated
using (public.is_admin());

create policy "Authenticated users can read published events"
on public.events
for select
to authenticated
using (status = 'published' or public.is_admin());

create policy "Admins can insert events"
on public.events
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update events"
on public.events
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can delete events"
on public.events
for delete
to authenticated
using (public.is_admin());

create policy "Authenticated users can read seats for published events"
on public.event_seats
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.events
    where events.id = event_seats.event_id
      and events.status = 'published'
  )
);

create policy "Admins can insert seats"
on public.event_seats
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update seats"
on public.event_seats
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can delete seats"
on public.event_seats
for delete
to authenticated
using (public.is_admin());
