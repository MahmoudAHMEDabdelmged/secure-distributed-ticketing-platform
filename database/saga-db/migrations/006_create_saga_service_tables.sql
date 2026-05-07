begin;

create extension if not exists "pgcrypto";

create table public.saga_flows (
  id uuid primary key default gen_random_uuid(),
  idempotency_key varchar(150) unique not null,
  saga_type varchar(100) not null default 'ticket_purchase',
  status varchar(50) not null default 'started',
  user_id uuid not null,
  booking_id uuid,
  payment_id uuid,
  ticket_ids uuid[],
  notification_ids uuid[],
  event_id uuid,
  section_id uuid,
  quantity int,
  amount_cents int,
  currency varchar(10) default 'EGP',
  current_step varchar(100),
  failure_reason text,
  retry_count int not null default 0,
  max_retries int not null default 3,
  is_retryable boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint saga_flows_status_check check (
    status in (
      'started',
      'booking_created',
      'payment_succeeded',
      'payment_failed',
      'payment_suspicious',
      'ticket_issued',
      'notification_sent',
      'notification_failed',
      'completed',
      'completed_with_notification_failed',
      'pending_ticket',
      'pending_notification',
      'compensated',
      'failed'
    )
  ),
  constraint saga_flows_quantity_check check (quantity is null or quantity > 0),
  constraint saga_flows_amount_cents_check check (amount_cents is null or amount_cents >= 0),
  constraint saga_flows_retry_count_check check (retry_count >= 0),
  constraint saga_flows_max_retries_check check (max_retries >= 0)
);

create table public.saga_steps (
  id uuid primary key default gen_random_uuid(),
  saga_id uuid not null references public.saga_flows(id) on delete cascade,
  step_name varchar(100) not null,
  status varchar(50) not null,
  attempt_count int not null default 1,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint saga_steps_attempt_count_check check (attempt_count > 0)
);

create index saga_flows_idempotency_key_idx on public.saga_flows (idempotency_key);
create index saga_flows_status_idx on public.saga_flows (status);
create index saga_flows_user_id_idx on public.saga_flows (user_id);
create index saga_flows_booking_id_idx on public.saga_flows (booking_id);
create index saga_flows_payment_id_idx on public.saga_flows (payment_id);
create index saga_flows_created_at_idx on public.saga_flows (created_at);

create index saga_steps_saga_id_idx on public.saga_steps (saga_id);
create index saga_steps_step_name_idx on public.saga_steps (step_name);
create index saga_steps_status_idx on public.saga_steps (status);

create or replace function public.set_saga_flows_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_saga_flows_updated_at
before update on public.saga_flows
for each row
execute function public.set_saga_flows_updated_at();

commit;
