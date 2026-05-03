create table public.event_seats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  seat_label text not null,
  section text,
  price numeric(10,2) not null,
  status public.seat_status default 'available',
  created_at timestamptz default now(),
  unique (event_id, seat_label),
  unique (id, event_id)
);

create index event_seats_event_id_idx on public.event_seats (event_id);
create index event_seats_event_status_idx on public.event_seats (event_id, status);
