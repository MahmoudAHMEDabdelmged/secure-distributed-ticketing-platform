begin;

create extension if not exists "pgcrypto";

create table if not exists public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid,
  recipient_role varchar,
  scope varchar not null default 'user',
  type varchar not null,
  title varchar not null,
  message text not null,
  severity varchar not null default 'info',
  resource_type varchar,
  resource_id varchar,
  metadata jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint in_app_notifications_scope_check
    check (scope in ('user', 'role', 'global')),
  constraint in_app_notifications_severity_check
    check (severity in ('info', 'success', 'warning', 'critical')),
  constraint in_app_notifications_recipient_check
    check (
      (scope = 'user' and recipient_user_id is not null)
      or (scope = 'role' and recipient_role is not null)
      or scope = 'global'
    )
);

create index if not exists in_app_notifications_recipient_user_id_idx
  on public.in_app_notifications (recipient_user_id);
create index if not exists in_app_notifications_recipient_role_idx
  on public.in_app_notifications (recipient_role);
create index if not exists in_app_notifications_scope_idx
  on public.in_app_notifications (scope);
create index if not exists in_app_notifications_type_idx
  on public.in_app_notifications (type);
create index if not exists in_app_notifications_severity_idx
  on public.in_app_notifications (severity);
create index if not exists in_app_notifications_is_read_idx
  on public.in_app_notifications (is_read);
create index if not exists in_app_notifications_created_at_idx
  on public.in_app_notifications (created_at);
create index if not exists in_app_notifications_user_feed_idx
  on public.in_app_notifications (recipient_user_id, is_read, created_at desc);
create index if not exists in_app_notifications_role_feed_idx
  on public.in_app_notifications (recipient_role, is_read, created_at desc);

commit;
