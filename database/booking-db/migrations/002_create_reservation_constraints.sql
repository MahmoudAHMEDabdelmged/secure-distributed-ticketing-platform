create index reservations_user_id_idx on public.reservations (user_id);
create index reservations_event_id_idx on public.reservations (event_id);
create index reservations_seat_id_idx on public.reservations (seat_id);
create index reservations_status_idx on public.reservations (status);
create index reservations_expires_at_idx on public.reservations (expires_at);
create index reservations_status_expires_at_idx on public.reservations (status, expires_at);

create unique index reservations_one_active_per_event_seat_idx
  on public.reservations (event_id, seat_id)
  where status in ('reserved', 'confirmed');
