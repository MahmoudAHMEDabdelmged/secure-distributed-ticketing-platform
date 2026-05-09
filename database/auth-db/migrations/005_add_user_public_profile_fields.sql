begin;

alter table public.users
  add column if not exists full_name text,
  add column if not exists phone text;

create index if not exists users_phone_idx on public.users (phone);

commit;