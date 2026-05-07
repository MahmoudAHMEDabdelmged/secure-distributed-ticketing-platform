begin;

create extension if not exists "pgcrypto";

create table public.security_audit_logs (
  id uuid primary key default gen_random_uuid(),
  event_type varchar(100) not null,
  service_name varchar(100) not null,
  severity varchar(20) not null default 'info',
  actor_user_id uuid,
  actor_role varchar(50),
  action varchar(150) not null,
  resource_type varchar(100),
  resource_id uuid,
  endpoint text,
  method varchar(20),
  status varchar(50),
  status_code int,
  ip_address varchar(100),
  user_agent text,
  is_suspicious boolean not null default false,
  suspicious_reason text,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint security_audit_logs_severity_check check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  constraint security_audit_logs_status_code_check check (status_code is null or (status_code >= 100 and status_code <= 599))
);

create index security_audit_logs_event_type_idx on public.security_audit_logs (event_type);
create index security_audit_logs_service_name_idx on public.security_audit_logs (service_name);
create index security_audit_logs_severity_idx on public.security_audit_logs (severity);
create index security_audit_logs_is_suspicious_idx on public.security_audit_logs (is_suspicious);
create index security_audit_logs_actor_user_id_idx on public.security_audit_logs (actor_user_id);
create index security_audit_logs_resource_type_idx on public.security_audit_logs (resource_type);
create index security_audit_logs_resource_id_idx on public.security_audit_logs (resource_id);
create index security_audit_logs_correlation_id_idx on public.security_audit_logs (correlation_id);
create index security_audit_logs_created_at_idx on public.security_audit_logs (created_at);

commit;
