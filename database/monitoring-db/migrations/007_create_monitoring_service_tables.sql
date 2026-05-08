begin;

create extension if not exists "pgcrypto";

create table if not exists public.service_health_checks (
  id uuid primary key default gen_random_uuid(),
  service_name varchar(100) not null,
  service_url text not null,
  check_type varchar(50) not null,
  status varchar(50) not null,
  http_status integer,
  latency_ms integer,
  response_summary jsonb not null default '{}'::jsonb,
  error_message text,
  checked_at timestamptz not null default now(),
  constraint service_health_checks_check_type_check
    check (check_type in ('health', 'deep_health')),
  constraint service_health_checks_status_check
    check (status in ('healthy', 'degraded', 'down'))
);

create table if not exists public.monitoring_incidents (
  id uuid primary key default gen_random_uuid(),
  service_name varchar(100) not null,
  incident_type varchar(100) not null,
  severity varchar(50) not null,
  status varchar(50) not null default 'open',
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  consecutive_failures integer not null default 1,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  constraint monitoring_incidents_status_check
    check (status in ('open', 'acknowledged', 'resolved')),
  constraint monitoring_incidents_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint monitoring_incidents_incident_type_check
    check (incident_type in (
      'SERVICE_DOWN',
      'SERVICE_DEGRADED',
      'DATABASE_DOWN',
      'SCHEMA_NOT_READY',
      'DEPENDENCY_DOWN',
      'HIGH_LATENCY'
    )),
  constraint monitoring_incidents_consecutive_failures_check
    check (consecutive_failures > 0)
);

create table if not exists public.monitoring_nodes (
  id uuid primary key default gen_random_uuid(),
  node_name varchar(150) unique not null,
  service_name varchar(100) not null,
  node_role varchar(50) not null default 'worker',
  status varchar(50) not null default 'unknown',
  last_heartbeat_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monitoring_nodes_status_check
    check (status in ('healthy', 'degraded', 'down', 'unknown'))
);

create table if not exists public.rsm_events (
  id uuid primary key default gen_random_uuid(),
  term integer not null default 1,
  log_index bigserial not null,
  event_type varchar(100) not null,
  command jsonb not null default '{}'::jsonb,
  status varchar(50) not null default 'committed',
  created_at timestamptz not null default now(),
  constraint rsm_events_term_check
    check (term > 0),
  constraint rsm_events_status_check
    check (status in ('pending', 'committed', 'rejected'))
);

create index if not exists service_health_checks_service_name_idx
  on public.service_health_checks (service_name);
create index if not exists service_health_checks_status_idx
  on public.service_health_checks (status);
create index if not exists service_health_checks_checked_at_idx
  on public.service_health_checks (checked_at);
create index if not exists service_health_checks_check_type_idx
  on public.service_health_checks (check_type);

create index if not exists monitoring_incidents_service_name_idx
  on public.monitoring_incidents (service_name);
create index if not exists monitoring_incidents_status_idx
  on public.monitoring_incidents (status);
create index if not exists monitoring_incidents_severity_idx
  on public.monitoring_incidents (severity);
create index if not exists monitoring_incidents_incident_type_idx
  on public.monitoring_incidents (incident_type);
create index if not exists monitoring_incidents_active_lookup_idx
  on public.monitoring_incidents (service_name, incident_type, status);

create index if not exists rsm_events_log_index_idx
  on public.rsm_events (log_index);

create or replace function public.set_monitoring_nodes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_monitoring_nodes_updated_at on public.monitoring_nodes;

create trigger set_monitoring_nodes_updated_at
before update on public.monitoring_nodes
for each row
execute function public.set_monitoring_nodes_updated_at();

commit;
