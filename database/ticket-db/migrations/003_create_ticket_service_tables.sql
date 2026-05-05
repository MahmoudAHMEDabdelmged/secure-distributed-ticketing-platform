begin;

create extension if not exists "pgcrypto";

create table public.issued_tickets (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  user_id uuid not null,
  user_email text,
  event_id uuid not null,
  section_id uuid not null,
  event_title text not null,
  section_name text not null,
  ticket_number text unique not null,
  verification_token_hash text unique not null,
  verification_url text not null,
  status text not null default 'valid',
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issued_tickets_status_check check (status in ('valid', 'used', 'cancelled', 'expired'))
);

create index issued_tickets_booking_id_idx on public.issued_tickets (booking_id);
create index issued_tickets_user_id_idx on public.issued_tickets (user_id);
create index issued_tickets_event_id_idx on public.issued_tickets (event_id);
create index issued_tickets_section_id_idx on public.issued_tickets (section_id);
create index issued_tickets_status_idx on public.issued_tickets (status);
create index issued_tickets_ticket_number_idx on public.issued_tickets (ticket_number);
create index issued_tickets_created_at_idx on public.issued_tickets (created_at);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger issued_tickets_set_updated_at
before update on public.issued_tickets
for each row
execute function public.set_updated_at();

commit;
