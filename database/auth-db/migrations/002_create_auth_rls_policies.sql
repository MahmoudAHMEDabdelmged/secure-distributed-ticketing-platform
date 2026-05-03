create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.prevent_non_admin_profile_role_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.id is distinct from old.id
      or new.email is distinct from old.email
      or new.role is distinct from old.role then
      raise exception 'Only admins can update profile identity, email, or role';
    end if;
  end if;

  new.updated_at = now();
  return new;
end;
$$;

create trigger prevent_non_admin_profile_role_changes
before update on public.profiles
for each row
execute function public.prevent_non_admin_profile_role_changes();

alter table public.profiles enable row level security;

revoke update on public.profiles from authenticated;
grant update (full_name, role) on public.profiles to authenticated;

create policy "Users can view their own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid());

create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "Admins can view all profiles"
on public.profiles
for select
to authenticated
using (public.is_admin());

create policy "Admins can update profiles"
on public.profiles
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());
