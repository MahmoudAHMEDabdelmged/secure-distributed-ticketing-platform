create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  role public.user_role default 'user',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index profiles_role_idx on public.profiles (role);
