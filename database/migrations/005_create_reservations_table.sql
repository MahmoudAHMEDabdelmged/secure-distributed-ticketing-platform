create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  seat_id uuid references public.event_seats(id) on delete cascade,
  status public.reservation_status default 'reserved',
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  foreign key (seat_id, event_id) references public.event_seats(id, event_id) on delete cascade
);

create index reservations_user_id_idx on public.reservations (user_id);
create index reservations_event_id_idx on public.reservations (event_id);
create index reservations_seat_id_idx on public.reservations (seat_id);
create index reservations_status_expires_at_idx on public.reservations (status, expires_at);

create unique index reservations_one_active_per_event_seat_idx
  on public.reservations (event_id, seat_id)
  where status in ('reserved', 'confirmed');
