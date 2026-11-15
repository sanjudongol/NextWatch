-- Watch Finder database setup. Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run again: it only creates what's missing.

-- 1. The shared catalog of titles (written only by the server's sync, read by signed-in people)
create table if not exists public.titles (
  id text primary key,                 -- e.g. "movie-872585" or "tv-1396"
  kind text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists titles_updated_at on public.titles (updated_at);

-- 2. One profile per person, created automatically at first sign-in
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  invite_code text unique not null default upper(substr(md5(random()::text), 1, 6)),
  partner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 3. "Want to watch" / "Not interested" (one row per person per title)
create table if not exists public.marks (
  user_id uuid not null references auth.users on delete cascade,
  title_id text not null,
  status text not null check (status in ('want', 'skipped')),
  primary key (user_id, title_id)
);

-- 4. "I watched it" (one row per person per title)
create table if not exists public.views (
  user_id uuid not null references auth.users on delete cascade,
  title_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, title_id)
);

-- Create a profile when someone signs in for the first time
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Is `other` linked to the person asking? (Both sides must point at each other.)
create or replace function public.is_my_partner(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles a join public.profiles b on a.partner_id = b.id
    where a.id = auth.uid() and b.id = other and b.partner_id = auth.uid()
  );
$$;

-- Link with a partner using their invite code
create or replace function public.link_partner(code text) returns text
language plpgsql security definer set search_path = public as $$
declare other public.profiles;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  select * into other from public.profiles where invite_code = upper(trim(code));
  if other.id is null then raise exception 'No one has that code. Check it and try again.'; end if;
  if other.id = auth.uid() then raise exception 'That is your own code. Enter your partner''s code instead.'; end if;
  if other.partner_id is not null and other.partner_id <> auth.uid() then
    raise exception 'That person is already linked with someone else. They need to unlink first.';
  end if;
  update public.profiles set partner_id = null where partner_id = auth.uid() and id <> other.id;
  update public.profiles set partner_id = other.id where id = auth.uid();
  update public.profiles set partner_id = auth.uid() where id = other.id;
  return other.name;
end $$;

create or replace function public.unlink_partner() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set partner_id = null where partner_id = auth.uid();
  update public.profiles set partner_id = null where id = auth.uid();
end $$;

-- Security: every table is locked down, then opened only as needed
alter table public.titles enable row level security;
alter table public.profiles enable row level security;
alter table public.marks enable row level security;
alter table public.views enable row level security;

drop policy if exists "signed-in people read the catalog" on public.titles;
create policy "signed-in people read the catalog" on public.titles for select to authenticated using (true);

drop policy if exists "see yourself and your partner" on public.profiles;
create policy "see yourself and your partner" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_my_partner(id));
drop policy if exists "rename yourself" on public.profiles;
create policy "rename yourself" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "own and partner marks: read" on public.marks;
create policy "own and partner marks: read" on public.marks for select to authenticated
  using (user_id = auth.uid() or (public.is_my_partner(user_id) and status = 'want'));  -- "Not interested" stays private
drop policy if exists "own marks: write" on public.marks;
create policy "own marks: write" on public.marks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Views: you can tick your own box, and your linked partner's box (handy on one shared screen)
drop policy if exists "own and partner views: read" on public.views;
create policy "own and partner views: read" on public.views for select to authenticated
  using (user_id = auth.uid() or public.is_my_partner(user_id));
drop policy if exists "own and partner views: write" on public.views;
create policy "own and partner views: write" on public.views for all to authenticated
  using (user_id = auth.uid() or public.is_my_partner(user_id))
  with check (user_id = auth.uid() or public.is_my_partner(user_id));

-- Table permissions
revoke all on public.titles, public.profiles, public.marks, public.views from anon, authenticated;
grant select on public.titles to authenticated;
grant select on public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;   -- partner links change only through the functions above
grant select, insert, update, delete on public.marks, public.views to authenticated;
grant all on public.titles, public.profiles, public.marks, public.views to service_role;
revoke execute on function public.handle_new_user() from public, anon, authenticated;   -- only the sign-up trigger runs it
revoke execute on function public.link_partner(text), public.unlink_partner(), public.is_my_partner(uuid) from public, anon;
grant execute on function public.link_partner(text), public.unlink_partner(), public.is_my_partner(uuid) to authenticated;

-- Profiles for anyone who signed in before this script ran
insert into public.profiles (id, name)
  select id, split_part(coalesce(email, ''), '@', 1) from auth.users
  on conflict (id) do nothing;
