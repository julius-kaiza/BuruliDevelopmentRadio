-- Buruli Development Radio production schema (safe to re-run).
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Community member',
  role text not null default 'listener',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists is_active boolean not null default true;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('listener','moderator','broadcaster','admin','root_admin'));
create unique index if not exists profiles_single_root_admin_idx on public.profiles ((role)) where role='root_admin';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name)
  values(new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), 'Community member'))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();

create table if not exists public.programmes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 160),
  description text,
  starts_at timestamptz not null,
  room_name text not null unique,
  is_live boolean not null default false,
  status text not null default 'scheduled' check (status in ('scheduled','live','ended','cancelled')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
alter table public.programmes add column if not exists status text not null default 'scheduled';
alter table public.programmes add column if not exists updated_at timestamptz not null default now();
update public.programmes set status = case when is_live then 'live' when ended_at is not null then 'ended' else 'scheduled' end where status='scheduled' and (is_live or ended_at is not null);
alter table public.programmes drop constraint if exists programmes_status_check;
alter table public.programmes add constraint programmes_status_check check(status in ('scheduled','live','ended','cancelled'));
-- Retain the most recently started live item if an earlier test created more than one.
update public.programmes set is_live=false,status=case when ended_at is not null then 'ended' else 'scheduled' end
where is_live and id not in (select id from public.programmes where is_live order by starts_at desc limit 1);
create unique index if not exists programmes_single_live_idx on public.programmes ((is_live)) where is_live=true;

create table if not exists public.radio_messages (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1500),
  created_at timestamptz not null default now()
);

create table if not exists public.speaker_requests (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','approved','declined')),
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(programme_id,user_id)
);

create table if not exists public.radio_recordings (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  egress_id text not null,
  object_path text not null,
  public_url text,
  status text not null default 'recording' check (status in ('recording','processing','ready','failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.radio_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check(char_length(title) between 2 and 160),
  body text not null check(char_length(body) between 2 and 5000),
  is_published boolean not null default false,
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.radio_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
insert into public.radio_settings(key,value) values
 ('station_name','"Buruli Development Radio"'::jsonb),
 ('station_tagline','"Our Community. Our Voice. Our Future."'::jsonb),
 ('maintenance_mode','false'::jsonb),
 ('allow_listener_chat','true'::jsonb),
 ('allow_speaker_requests','true'::jsonb)
on conflict(key) do nothing;

create table if not exists public.radio_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists programmes_starts_at_idx on public.programmes(starts_at);
create index if not exists programmes_live_idx on public.programmes(is_live) where is_live=true;
create index if not exists messages_programme_created_idx on public.radio_messages(programme_id,created_at desc);
create index if not exists requests_programme_status_idx on public.speaker_requests(programme_id,status);
create index if not exists announcements_published_idx on public.radio_announcements(is_published,published_at desc);

alter table public.profiles enable row level security;
alter table public.programmes enable row level security;
alter table public.radio_messages enable row level security;
alter table public.speaker_requests enable row level security;
alter table public.radio_recordings enable row level security;
alter table public.radio_announcements enable row level security;
alter table public.radio_settings enable row level security;
alter table public.radio_audit_log enable row level security;

-- Drop policies from earlier iterations before installing the stricter policies.
do $$ declare p record; begin
  for p in select schemaname,tablename,policyname from pg_policies where schemaname='public' and tablename in ('profiles','programmes','radio_messages','speaker_requests','radio_recordings','radio_announcements','radio_settings','radio_audit_log') loop
    execute format('drop policy if exists %I on %I.%I',p.policyname,p.schemaname,p.tablename);
  end loop;
end $$;

create policy profiles_read on public.profiles for select using (true);
-- Users may update their display name only; role and active status are server-managed.
create policy profiles_update_own on public.profiles for update using (auth.uid()=id) with check (auth.uid()=id);
revoke update on public.profiles from authenticated;
grant update(display_name) on public.profiles to authenticated;
grant select on public.profiles to anon, authenticated;

create policy programmes_public_read on public.programmes for select using (true);
create policy programmes_staff_insert on public.programmes for insert to authenticated with check (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster'))
);
create policy programmes_staff_update on public.programmes for update to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster'))
) with check (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster'))
);
create policy programmes_admin_delete on public.programmes for delete to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin'))
);
grant select on public.programmes to anon,authenticated;
grant insert,update,delete on public.programmes to authenticated;

create policy messages_public_read on public.radio_messages for select using (true);
create policy messages_active_insert on public.radio_messages for insert to authenticated with check (
 auth.uid()=user_id and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active)
 and exists(select 1 from public.programmes pr where pr.id=programme_id and pr.is_live=true)
 and coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='allow_listener_chat'),true)
 and not coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='maintenance_mode'),false)
);
create policy messages_owner_or_staff_delete on public.radio_messages for delete to authenticated using (
 auth.uid()=user_id or exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
grant select on public.radio_messages to anon,authenticated;
grant insert,delete on public.radio_messages to authenticated;

create policy requests_owner_staff_read on public.speaker_requests for select to authenticated using (
 auth.uid()=user_id or exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
create policy requests_owner_insert on public.speaker_requests for insert to authenticated with check (
 auth.uid()=user_id and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active)
 and exists(select 1 from public.programmes pr where pr.id=programme_id and pr.is_live=true)
 and coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='allow_speaker_requests'),true)
 and not coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='maintenance_mode'),false)
);
create policy requests_owner_retry on public.speaker_requests for update to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id and status='pending' and reviewed_by is null and exists(select 1 from public.programmes pr where pr.id=programme_id and pr.is_live=true) and coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='allow_speaker_requests'),true) and not coalesce((select (value #>> '{}')::boolean from public.radio_settings where key='maintenance_mode'),false));
create policy requests_staff_update on public.speaker_requests for update to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
) with check (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
grant select,insert,update on public.speaker_requests to authenticated;

create policy recordings_public_ready_read on public.radio_recordings for select using (status='ready' and public_url is not null);
create policy recordings_staff_read on public.radio_recordings for select to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
grant select on public.radio_recordings to anon,authenticated;

create policy announcements_public_read on public.radio_announcements for select using (is_published=true);
create policy announcements_staff_read on public.radio_announcements for select to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
create policy announcements_staff_insert on public.radio_announcements for insert to authenticated with check (
 created_by=auth.uid() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
create policy announcements_staff_update on public.radio_announcements for update to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
) with check (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin','broadcaster','moderator'))
);
create policy announcements_admin_delete on public.radio_announcements for delete to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role in ('root_admin','admin'))
);
grant select on public.radio_announcements to anon,authenticated;
grant insert,update,delete on public.radio_announcements to authenticated;

create policy settings_public_read on public.radio_settings for select using (key in ('station_name','station_tagline','maintenance_mode','allow_listener_chat','allow_speaker_requests'));
create policy settings_root_manage on public.radio_settings for all to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='root_admin')
) with check (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='root_admin')
);
grant select on public.radio_settings to anon,authenticated;
grant insert,update,delete on public.radio_settings to authenticated;

create policy audit_root_read on public.radio_audit_log for select to authenticated using (
 exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role='root_admin')
);
grant select on public.radio_audit_log to authenticated;

-- Enable realtime for the tables used by the public app.
do $$ begin alter publication supabase_realtime add table public.programmes; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.radio_messages; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.speaker_requests; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.radio_announcements; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.radio_recordings; exception when duplicate_object then null; when undefined_object then null; end $$;

-- ROOT ADMIN BOOTSTRAP:
-- Create and verify the first user in the app, then set ROOT_ADMIN_EMAIL in Render.
-- The backend promotes only that exact email using the service-role key at startup.
