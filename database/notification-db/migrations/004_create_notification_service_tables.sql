begin;

create extension if not exists "pgcrypto";

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_type varchar not null,
  recipient_email varchar not null,
  subject text not null,
  status varchar not null default 'pending',
  booking_id uuid,
  ticket_id uuid,
  payment_id uuid,
  alert_severity varchar,
  provider_message_id text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_type_check check (
    notification_type in (
      'ticket_email',
      'booking_confirmation',
      'payment_success',
      'payment_failed',
      'security_alert'
    )
  ),
  constraint notification_deliveries_status_check check (status in ('pending', 'sent', 'failed')),
  constraint notification_deliveries_alert_severity_check check (
    alert_severity is null or alert_severity in ('low', 'medium', 'high', 'critical')
  )
);

create index notification_deliveries_booking_id_idx on public.notification_deliveries (booking_id);
create index notification_deliveries_ticket_id_idx on public.notification_deliveries (ticket_id);
create index notification_deliveries_payment_id_idx on public.notification_deliveries (payment_id);
create index notification_deliveries_status_idx on public.notification_deliveries (status);
create index notification_deliveries_notification_type_idx on public.notification_deliveries (notification_type);
create index notification_deliveries_created_at_idx on public.notification_deliveries (created_at);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger notification_deliveries_set_updated_at
before update on public.notification_deliveries
for each row
execute function public.set_updated_at();

commit;
