begin;

create extension if not exists "pgcrypto";

create table if not exists public.coordinator_nodes (
  node_id text primary key,
  role text not null check (role in ('leader', 'follower', 'candidate', 'crashed', 'recovering')),
  status text not null check (status in ('healthy', 'degraded', 'crashed', 'recovering')),
  current_term integer not null default 0,
  voted_for text,
  last_heartbeat_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.leader_terms (
  id uuid primary key default gen_random_uuid(),
  term integer not null,
  leader_id text not null,
  elected_at timestamptz default now(),
  reason text
);

create table if not exists public.leader_votes (
  id uuid primary key default gen_random_uuid(),
  term integer not null,
  candidate_id text not null,
  voter_id text not null,
  granted boolean not null,
  reason text,
  created_at timestamptz default now(),
  unique (term, voter_id)
);

create table if not exists public.heartbeats (
  id uuid primary key default gen_random_uuid(),
  term integer not null,
  leader_id text not null,
  follower_id text not null,
  status text not null,
  created_at timestamptz default now()
);

create table if not exists public.replicated_log (
  log_index bigserial primary key,
  term integer not null,
  leader_id text not null,
  rsm_id uuid,
  booking_id text,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  ordering_type text not null check (ordering_type in ('fifo', 'causal', 'total')),
  status text not null check (status in ('pending', 'committed', 'rejected', 'failed')),
  commit_quorum integer not null,
  ack_count integer not null default 0,
  created_at timestamptz default now(),
  committed_at timestamptz
);

create table if not exists public.log_replication_acks (
  id uuid primary key default gen_random_uuid(),
  log_index bigint not null references public.replicated_log(log_index) on delete cascade,
  node_id text not null,
  ack_status text not null check (ack_status in ('acked', 'rejected', 'timeout')),
  reason text,
  created_at timestamptz default now(),
  unique (log_index, node_id)
);

create table if not exists public.rsm_instances (
  rsm_id uuid primary key default gen_random_uuid(),
  booking_id text unique,
  current_state text not null,
  version integer not null default 0,
  status text not null check (status in ('active', 'completed', 'failed', 'compensated')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.rsm_transitions (
  transition_id uuid primary key default gen_random_uuid(),
  rsm_id uuid not null references public.rsm_instances(rsm_id) on delete cascade,
  log_index bigint references public.replicated_log(log_index),
  from_state text not null,
  to_state text not null,
  event_type text not null,
  valid boolean not null,
  rejection_reason text,
  term integer,
  committed_by_leader text,
  created_at timestamptz default now()
);

create table if not exists public.consensus_outbox (
  id uuid primary key default gen_random_uuid(),
  log_index bigint references public.replicated_log(log_index) on delete cascade,
  target_node_id text not null,
  message_type text not null,
  payload jsonb default '{}'::jsonb,
  status text not null check (status in ('pending', 'delivered', 'failed', 'retrying')),
  retry_count integer not null default 0,
  last_error text,
  created_at timestamptz default now(),
  processed_at timestamptz
);

create table if not exists public.broadcast_messages (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('synchronous', 'asynchronous')),
  leader_id text not null,
  term integer not null,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  required_acks integer not null,
  received_acks integer not null default 0,
  result text not null check (result in ('pending', 'committed', 'rejected', 'failed')),
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table if not exists public.broadcast_acks (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.broadcast_messages(id) on delete cascade,
  node_id text not null,
  ack_status text not null check (ack_status in ('acked', 'rejected', 'timeout')),
  reason text,
  created_at timestamptz default now(),
  unique (broadcast_id, node_id)
);

create table if not exists public.infrastructure_topology (
  id uuid primary key default gen_random_uuid(),
  service_name text not null,
  service_type text not null,
  replicas integer not null default 1,
  database_name text,
  region text default 'primary-region',
  availability_zone text default 'az-1',
  estimated_rps integer default 0,
  status text default 'planned',
  created_at timestamptz default now()
);

create table if not exists public.fault_injection_events (
  id uuid primary key default gen_random_uuid(),
  node_id text,
  event_type text not null check (event_type in ('crash', 'recover', 'timeout', 'degraded')),
  reason text,
  system_safety text,
  system_liveness text,
  created_at timestamptz default now()
);

create index if not exists coordinator_nodes_status_idx on public.coordinator_nodes (status);
create index if not exists coordinator_nodes_role_idx on public.coordinator_nodes (role);
create index if not exists leader_terms_term_idx on public.leader_terms (term);
create index if not exists heartbeats_leader_id_idx on public.heartbeats (leader_id);
create index if not exists replicated_log_rsm_id_idx on public.replicated_log (rsm_id);
create index if not exists replicated_log_booking_id_idx on public.replicated_log (booking_id);
create index if not exists replicated_log_status_idx on public.replicated_log (status);
create index if not exists replicated_log_ordering_idx on public.replicated_log (ordering_type, log_index);
create index if not exists log_replication_acks_node_id_idx on public.log_replication_acks (node_id);
create index if not exists rsm_transitions_rsm_id_idx on public.rsm_transitions (rsm_id);
create index if not exists consensus_outbox_status_idx on public.consensus_outbox (status);
create index if not exists consensus_outbox_target_idx on public.consensus_outbox (target_node_id, status);
create index if not exists broadcast_messages_mode_idx on public.broadcast_messages (mode);
create index if not exists broadcast_acks_node_id_idx on public.broadcast_acks (node_id);
create index if not exists infrastructure_topology_service_name_idx on public.infrastructure_topology (service_name);
create index if not exists fault_injection_events_node_id_idx on public.fault_injection_events (node_id);

create or replace function public.set_coordinator_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_coordinator_nodes_updated_at'
  ) then
    create trigger set_coordinator_nodes_updated_at
    before update on public.coordinator_nodes
    for each row
    execute function public.set_coordinator_updated_at();
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'set_rsm_instances_updated_at'
  ) then
    create trigger set_rsm_instances_updated_at
    before update on public.rsm_instances
    for each row
    execute function public.set_coordinator_updated_at();
  end if;
end;
$$;

insert into public.infrastructure_topology (
  service_name,
  service_type,
  replicas,
  database_name,
  region,
  availability_zone,
  estimated_rps,
  status
)
select
  seed.service_name,
  seed.service_type,
  seed.replicas,
  seed.database_name,
  seed.region,
  seed.availability_zone,
  seed.estimated_rps,
  seed.status
from (
  values
    ('api-gateway', 'gateway', 1, null, 'primary-region', 'az-1', 600, 'active'),
    ('auth-service', 'backend-service', 1, 'auth-db', 'primary-region', 'az-1', 120, 'active'),
    ('events-service', 'backend-service', 1, 'events-db', 'primary-region', 'az-1', 220, 'active'),
    ('booking-service', 'backend-service', 1, 'booking-db', 'primary-region', 'az-1', 260, 'active'),
    ('payment-service', 'backend-service', 1, 'payment-db', 'primary-region', 'az-1', 180, 'active'),
    ('ticket-service', 'backend-service', 1, 'ticket-db', 'primary-region', 'az-1', 240, 'active'),
    ('notification-service', 'backend-service', 1, 'notification-db', 'primary-region', 'az-1', 160, 'active'),
    ('audit-service', 'backend-service', 1, 'audit-db', 'primary-region', 'az-1', 180, 'active'),
    ('saga-service', 'backend-service', 1, 'saga-db', 'primary-region', 'az-1', 140, 'active'),
    ('monitoring-service', 'backend-service', 1, 'monitoring-db', 'primary-region', 'az-1', 80, 'active'),
    ('coordinator-service', 'consensus-service', 3, 'coordinator-db', 'primary-region', 'az-1', 180, 'active')
) as seed(
  service_name,
  service_type,
  replicas,
  database_name,
  region,
  availability_zone,
  estimated_rps,
  status
)
where not exists (
  select 1
  from public.infrastructure_topology existing
  where existing.service_name = seed.service_name
);

commit;
