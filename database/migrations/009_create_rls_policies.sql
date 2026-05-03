create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.venues enable row level security;
alter table public.events enable row level security;
alter table public.event_seats enable row level security;
alter table public.reservations enable row level security;
alter table public.payments enable row level security;
alter table public.tickets enable row level security;
alter table public.audit_logs enable row level security;

revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy "Users can view their own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid());

create policy "Users can update their own full name"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "Admins can view all profiles"
on public.profiles
for select
to authenticated
using (public.is_admin());

create policy "Authenticated users can view venues for published events"
on public.venues
for select
to authenticated
using (
  exists (
    select 1
    from public.events
    where events.venue_id = venues.id
      and events.status = 'published'
  )
  or public.is_admin()
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

create policy "Authenticated users can view published events"
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

create policy "Authenticated users can view seats for published events"
on public.event_seats
for select
to authenticated
using (
  exists (
    select 1
    from public.events
    where events.id = event_seats.event_id
      and events.status = 'published'
  )
  or public.is_admin()
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

create policy "Users can view their own reservations"
on public.reservations
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Users can create their own reservations"
on public.reservations
for insert
to authenticated
with check (user_id = auth.uid());

create policy "Admins can update reservations"
on public.reservations
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins can delete reservations"
on public.reservations
for delete
to authenticated
using (public.is_admin());

create policy "Users can view their own payments"
on public.payments
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Admins can insert payments"
on public.payments
for insert
to authenticated
with check (public.is_admin());

create policy "Admins can update payments"
on public.payments
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Users can view their own tickets"
on public.tickets
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

create policy "Admins can view audit logs"
on public.audit_logs
for select
to authenticated
using (public.is_admin());
