create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  seat_id uuid references public.event_seats(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  ticket_code text unique not null,
  qr_code_data text,
  status public.ticket_status default 'active',
  created_at timestamptz default now(),
  foreign key (seat_id, event_id) references public.event_seats(id, event_id) on delete cascade
);

create index tickets_user_id_idx on public.tickets (user_id);
create index tickets_event_id_idx on public.tickets (event_id);
create index tickets_seat_id_idx on public.tickets (seat_id);
create index tickets_reservation_id_idx on public.tickets (reservation_id);
create index tickets_status_idx on public.tickets (status);
