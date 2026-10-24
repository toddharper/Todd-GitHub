-- =====================================================================
-- Venue Network Atlas — Supabase schema
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: everything is created "if not exists" or replaced.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Access list (invite-only sign-in + roles)
--    viewer = read everything, editor = also change venues,
--    admin  = also manage this list
-- ---------------------------------------------------------------------
create table if not exists public.allowed_users (
  email        text primary key check (email = lower(email) and email like '%@%'),
  role         text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  display_name text not null default '',
  added_at     timestamptz not null default now(),
  added_by     text not null default ''
);

-- The signed-in person's role, or null when they are not on the list.
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.allowed_users
  where email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.can_view() returns boolean
language sql stable as $$ select public.app_role() is not null $$;

create or replace function public.can_edit() returns boolean
language sql stable as $$ select coalesce(public.app_role() in ('editor', 'admin'), false) $$;

create or replace function public.is_admin() returns boolean
language sql stable as $$ select coalesce(public.app_role() = 'admin', false) $$;

-- Never leave the app without an admin.
create or replace function public.keep_one_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    if (select count(*) from public.allowed_users where role = 'admin' and email <> old.email) = 0 then
      raise exception 'At least one admin is required. Make someone else an admin first.';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists keep_one_admin on public.allowed_users;
create trigger keep_one_admin before update or delete on public.allowed_users
  for each row execute function public.keep_one_admin();

-- Normalize emails people type into the list.
create or replace function public.normalize_allowed_email() returns trigger
language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  if tg_op = 'INSERT' and new.added_by = '' then
    new.added_by := lower(coalesce(auth.jwt() ->> 'email', ''));
  end if;
  return new;
end $$;

drop trigger if exists normalize_allowed_email on public.allowed_users;
create trigger normalize_allowed_email before insert or update on public.allowed_users
  for each row execute function public.normalize_allowed_email();

-- Invite-only: refuse to create a login for anyone not on the list.
create or replace function public.enforce_allow_list() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_users where email = lower(new.email)) then
    raise exception 'This email is not on the Venue Network Atlas access list.';
  end if;
  return new;
end $$;

drop trigger if exists enforce_allow_list on auth.users;
create trigger enforce_allow_list before insert on auth.users
  for each row execute function public.enforce_allow_list();

-- ---------------------------------------------------------------------
-- 2. Venue data
-- ---------------------------------------------------------------------
create table if not exists public.venues (
  id               text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name             text not null check (length(trim(name)) > 0),
  code             text not null default '',
  portfolio        text not null default 'Legends',
  status           text not null default 'Active' check (status in ('Active', 'Obsolete')),
  description      text not null default '',
  client           text not null default '',
  address          text not null default '',
  city             text not null default '',
  state            text not null default '',
  zip              text not null default '',
  country          text not null default '',
  contact_name     text not null default '',
  contact_title    text not null default '',
  contact_phone    text not null default '',
  contact_email    text not null default '',
  contact_employer text not null default '',
  venue_tech       text not null default '',
  notes            text not null default '',
  parent_id        text references public.venues (id) on delete set null,
  diagram_path     text not null default '',
  diagram_kind     text not null default '',
  diagram_notes    text not null default '',
  updated_at       timestamptz not null default now(),
  updated_by       text not null default ''
);

create table if not exists public.equipment (
  id        uuid primary key default gen_random_uuid(),
  venue_id  text not null references public.venues (id) on delete cascade,
  position  int  not null default 0,
  hostname  text not null default '',
  role      text not null default '',
  model     text not null default '',
  serial    text not null default '',
  mgmt_ip   text not null default '',
  location  text not null default '',
  notes     text not null default ''
);
create index if not exists equipment_venue_idx on public.equipment (venue_id);

create table if not exists public.circuits (
  id         uuid primary key default gen_random_uuid(),
  venue_id   text not null references public.venues (id) on delete cascade,
  position   int  not null default 0,
  role       text not null default '',
  carrier    text not null default '',
  circuit_id text not null default '',
  bandwidth  text not null default '',
  ip_block   text not null default '',
  gateway    text not null default '',
  account    text not null default '',
  support    text not null default '',
  status     text not null default '',
  notes      text not null default ''
);
create index if not exists circuits_venue_idx on public.circuits (venue_id);

create table if not exists public.ip_addresses (
  id        uuid primary key default gen_random_uuid(),
  venue_id  text not null references public.venues (id) on delete cascade,
  position  int  not null default 0,
  vlan      text not null default '',
  name      text not null default '',
  subnet    text not null default '',
  gateway   text not null default '',
  dhcp      text not null default '',
  notes     text not null default ''
);
create index if not exists ip_addresses_venue_idx on public.ip_addresses (venue_id);

-- Every save and delete is recorded with who did it and a full snapshot.
create table if not exists public.venue_changes (
  id         bigint generated always as identity primary key,
  venue_id   text not null,
  action     text not null check (action in ('create', 'update', 'delete')),
  changed_at timestamptz not null default now(),
  changed_by text not null default '',
  snapshot   jsonb not null
);
create index if not exists venue_changes_venue_idx on public.venue_changes (venue_id, changed_at desc);

-- ---------------------------------------------------------------------
-- 3. Save / delete functions (one transaction per venue)
-- ---------------------------------------------------------------------
create or replace function public.venue_snapshot(v_id text) returns jsonb
language sql stable set search_path = public as $$
  select to_jsonb(v) || jsonb_build_object(
    'equipment',    coalesce((select jsonb_agg(to_jsonb(e) - 'venue_id' - 'id' order by e.position) from equipment e where e.venue_id = v.id), '[]'),
    'circuits',     coalesce((select jsonb_agg(to_jsonb(c) - 'venue_id' - 'id' order by c.position) from circuits c where c.venue_id = v.id), '[]'),
    'ip_addresses', coalesce((select jsonb_agg(to_jsonb(i) - 'venue_id' - 'id' order by i.position) from ip_addresses i where i.venue_id = v.id), '[]'))
  from venues v where v.id = v_id;
$$;

-- payload: the venue's columns plus arrays "equipment", "circuits", "ip_addresses".
-- is_new: true when creating (refuses to overwrite an existing id).
-- expected_updated_at: the updated_at the editor started from; if someone saved
--   in the meantime the save is refused instead of overwriting their change.
create or replace function public.save_venue(payload jsonb, is_new boolean default false, expected_updated_at timestamptz default null)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_id    text := payload ->> 'id';
  who     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  cur_ts  timestamptz;
begin
  if not public.can_edit() then
    raise exception 'You have view-only access.' using errcode = '42501';
  end if;
  if coalesce(trim(payload ->> 'name'), '') = '' then
    raise exception 'Give the venue a name before saving.';
  end if;

  select updated_at into cur_ts from venues where id = v_id for update;
  if is_new and found then
    raise exception 'A venue with the ID "%" already exists.', v_id using errcode = '23505';
  end if;
  if not is_new and not found then
    raise exception 'This venue was deleted by someone else.' using errcode = 'P0002';
  end if;
  if not is_new and expected_updated_at is not null and cur_ts <> expected_updated_at then
    raise exception 'Someone else saved this venue after you opened it.' using errcode = '40001';
  end if;

  insert into venues as t (
    id, name, code, portfolio, status, description, client, address, city, state, zip, country,
    contact_name, contact_title, contact_phone, contact_email, contact_employer, venue_tech,
    notes, parent_id, diagram_path, diagram_kind, diagram_notes, updated_at, updated_by)
  values (
    v_id, trim(payload ->> 'name'),
    coalesce(payload ->> 'code', ''), coalesce(nullif(payload ->> 'portfolio', ''), 'Legends'),
    coalesce(nullif(payload ->> 'status', ''), 'Active'), coalesce(payload ->> 'description', ''),
    coalesce(payload ->> 'client', ''), coalesce(payload ->> 'address', ''), coalesce(payload ->> 'city', ''),
    coalesce(payload ->> 'state', ''), coalesce(payload ->> 'zip', ''), coalesce(payload ->> 'country', ''),
    coalesce(payload ->> 'contact_name', ''), coalesce(payload ->> 'contact_title', ''),
    coalesce(payload ->> 'contact_phone', ''), coalesce(payload ->> 'contact_email', ''),
    coalesce(payload ->> 'contact_employer', ''), coalesce(payload ->> 'venue_tech', ''),
    coalesce(payload ->> 'notes', ''), nullif(payload ->> 'parent_id', ''),
    coalesce(payload ->> 'diagram_path', ''), coalesce(payload ->> 'diagram_kind', ''),
    coalesce(payload ->> 'diagram_notes', ''), now(), who)
  on conflict (id) do update set
    name = excluded.name, code = excluded.code, portfolio = excluded.portfolio, status = excluded.status,
    description = excluded.description, client = excluded.client, address = excluded.address,
    city = excluded.city, state = excluded.state, zip = excluded.zip, country = excluded.country,
    contact_name = excluded.contact_name, contact_title = excluded.contact_title,
    contact_phone = excluded.contact_phone, contact_email = excluded.contact_email,
    contact_employer = excluded.contact_employer, venue_tech = excluded.venue_tech,
    notes = excluded.notes, parent_id = excluded.parent_id, diagram_path = excluded.diagram_path,
    diagram_kind = excluded.diagram_kind, diagram_notes = excluded.diagram_notes,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  delete from equipment where venue_id = v_id;
  insert into equipment (venue_id, position, hostname, role, model, serial, mgmt_ip, location, notes)
  select v_id, (n - 1)::int, coalesce(r ->> 'hostname', ''), coalesce(r ->> 'role', ''), coalesce(r ->> 'model', ''),
         coalesce(r ->> 'serial', ''), coalesce(r ->> 'mgmt_ip', ''), coalesce(r ->> 'location', ''), coalesce(r ->> 'notes', '')
  from jsonb_array_elements(coalesce(payload -> 'equipment', '[]'::jsonb)) with ordinality as x(r, n);

  delete from circuits where venue_id = v_id;
  insert into circuits (venue_id, position, role, carrier, circuit_id, bandwidth, ip_block, gateway, account, support, status, notes)
  select v_id, (n - 1)::int, coalesce(r ->> 'role', ''), coalesce(r ->> 'carrier', ''), coalesce(r ->> 'circuit_id', ''),
         coalesce(r ->> 'bandwidth', ''), coalesce(r ->> 'ip_block', ''), coalesce(r ->> 'gateway', ''),
         coalesce(r ->> 'account', ''), coalesce(r ->> 'support', ''), coalesce(r ->> 'status', ''), coalesce(r ->> 'notes', '')
  from jsonb_array_elements(coalesce(payload -> 'circuits', '[]'::jsonb)) with ordinality as x(r, n);

  delete from ip_addresses where venue_id = v_id;
  insert into ip_addresses (venue_id, position, vlan, name, subnet, gateway, dhcp, notes)
  select v_id, (n - 1)::int, coalesce(r ->> 'vlan', ''), coalesce(r ->> 'name', ''), coalesce(r ->> 'subnet', ''),
         coalesce(r ->> 'gateway', ''), coalesce(r ->> 'dhcp', ''), coalesce(r ->> 'notes', '')
  from jsonb_array_elements(coalesce(payload -> 'ip_addresses', '[]'::jsonb)) with ordinality as x(r, n);

  insert into venue_changes (venue_id, action, changed_by, snapshot)
  values (v_id, case when is_new then 'create' else 'update' end, who, public.venue_snapshot(v_id));

  return public.venue_snapshot(v_id);
end $$;

create or replace function public.delete_venue(v_id text) returns void
language plpgsql security invoker set search_path = public as $$
declare snap jsonb;
begin
  if not public.can_edit() then
    raise exception 'You have view-only access.' using errcode = '42501';
  end if;
  snap := public.venue_snapshot(v_id);
  if snap is null then return; end if;
  insert into venue_changes (venue_id, action, changed_by, snapshot)
  values (v_id, 'delete', lower(coalesce(auth.jwt() ->> 'email', '')), snap);
  delete from venues where id = v_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Row-level security: nothing is readable without being on the list
-- ---------------------------------------------------------------------
alter table public.allowed_users enable row level security;
alter table public.venues        enable row level security;
alter table public.equipment     enable row level security;
alter table public.circuits      enable row level security;
alter table public.ip_addresses  enable row level security;
alter table public.venue_changes enable row level security;

do $$
declare t text;
begin
  foreach t in array array['venues', 'equipment', 'circuits', 'ip_addresses'] loop
    execute format('drop policy if exists "list members read" on public.%I', t);
    execute format('drop policy if exists "editors write" on public.%I', t);
    execute format('create policy "list members read" on public.%I for select to authenticated using (public.can_view())', t);
    execute format('create policy "editors write" on public.%I for all to authenticated using (public.can_edit()) with check (public.can_edit())', t);
  end loop;
end $$;

drop policy if exists "list members read history" on public.venue_changes;
drop policy if exists "editors add history" on public.venue_changes;
create policy "list members read history" on public.venue_changes for select to authenticated using (public.can_view());
create policy "editors add history" on public.venue_changes for insert to authenticated with check (public.can_edit());

drop policy if exists "see own entry or admin sees all" on public.allowed_users;
drop policy if exists "admins manage list" on public.allowed_users;
create policy "see own entry or admin sees all" on public.allowed_users for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin());
create policy "admins manage list" on public.allowed_users for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Signed-out visitors get nothing at all.
revoke all on public.allowed_users, public.venues, public.equipment, public.circuits,
              public.ip_addresses, public.venue_changes from anon;
revoke execute on function public.save_venue(jsonb, boolean, timestamptz), public.delete_venue(text),
                           public.venue_snapshot(text) from anon, public;
grant execute on function public.save_venue(jsonb, boolean, timestamptz), public.delete_venue(text),
                          public.venue_snapshot(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Site diagram storage (private bucket, 20 MB per file)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diagrams', 'diagrams', false, 20971520,
        array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "atlas diagrams read" on storage.objects;
drop policy if exists "atlas diagrams upload" on storage.objects;
drop policy if exists "atlas diagrams change" on storage.objects;
drop policy if exists "atlas diagrams delete" on storage.objects;
create policy "atlas diagrams read" on storage.objects for select to authenticated
  using (bucket_id = 'diagrams' and public.can_view());
create policy "atlas diagrams upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'diagrams' and public.can_edit());
create policy "atlas diagrams change" on storage.objects for update to authenticated
  using (bucket_id = 'diagrams' and public.can_edit()) with check (bucket_id = 'diagrams' and public.can_edit());
create policy "atlas diagrams delete" on storage.objects for delete to authenticated
  using (bucket_id = 'diagrams' and public.can_edit());
