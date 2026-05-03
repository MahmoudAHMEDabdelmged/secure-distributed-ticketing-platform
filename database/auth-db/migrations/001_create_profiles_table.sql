create table public.profiles (
  id uuid primary key,
  email text unique not null,
  full_name text,
  role text check (role in ('user', 'admin')) default 'user',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index profiles_role_idx on public.profiles (role);
create index profiles_email_idx on public.profiles (email);
