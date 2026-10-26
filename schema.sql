-- Trace by XYB — schema v2 (una cuenta por persona)
--
-- Ejecutar completo en Supabase > SQL Editor > New query > Run.
-- Es idempotente y se puede correr sobre una base v1 sin borrar datos:
-- lo que ya existía se asigna a la cuenta más vieja.
--
-- Cada fila de targets/events pertenece a un `owner` (el usuario del panel).
-- Cada cuenta guarda su propio token de Discord y la identidad vinculada.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ accounts

create table if not exists public.accounts (
  username         text primary key,
  role             text not null default 'user',
  password_salt    text not null,
  password_hash    text not null,
  hwid_hash        text,
  hwid_label       text,
  session_version  integer not null default 0,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz,
  last_ip          text
);

alter table public.accounts add column if not exists discord_token    text;
alter table public.accounts add column if not exists discord_user_id  text;
alter table public.accounts add column if not exists discord_username text;
alter table public.accounts add column if not exists discord_avatar   text;

create index if not exists accounts_hwid_idx on public.accounts (hwid_hash);

-- ------------------------------------------------------------------- targets

create table if not exists public.targets (
  owner      text not null,
  user_id    text not null,
  username   text,
  note       text,
  created_at timestamptz not null default now(),
  primary key (owner, user_id)
);

-- Migración v1 -> v2: la tabla vieja no tenía owner.
alter table public.targets add column if not exists owner text;
update public.targets
   set owner = coalesce(
     (select username from public.accounts order by created_at asc limit 1),
     'legacy'
   )
 where owner is null;
alter table public.targets alter column owner set not null;
alter table public.targets drop constraint if exists targets_pkey;
alter table public.targets add primary key (owner, user_id);

create index if not exists targets_owner_idx on public.targets (owner, created_at desc);

-- -------------------------------------------------------------------- events

create table if not exists public.events (
  id           bigserial primary key,
  event_type   text not null,
  message_id   text,
  user_id      text not null,
  username     text,
  guild_id     text,
  guild_name   text,
  channel_id   text,
  channel_name text,
  content      text,
  old_content  text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

alter table public.events add column if not exists owner text;
update public.events
   set owner = coalesce(
     (select username from public.accounts order by created_at asc limit 1),
     'legacy'
   )
 where owner is null;
alter table public.events alter column owner set not null;

create index if not exists events_owner_created_idx on public.events (owner, created_at desc);
create index if not exists events_owner_type_idx    on public.events (owner, event_type, created_at desc);
create index if not exists events_owner_user_idx    on public.events (owner, user_id, created_at desc);
create index if not exists events_created_at_idx    on public.events (created_at desc);
create index if not exists events_message_idx       on public.events (message_id, event_type);
create index if not exists events_guild_idx         on public.events (guild_id, created_at desc);

-- RLS on, cero policies: solo la service_role key del servidor puede leer/escribir.
alter table public.targets  enable row level security;
alter table public.events   enable row level security;
alter table public.accounts enable row level security;

-- Conteo por tipo para el resumen del panel en una sola consulta. Sin esto el
-- panel tendría que pedir 11 counts por owner y la latencia se nota.
create or replace function public.event_stats(p_owner text, p_since timestamptz)
returns table (event_type text, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  select e.event_type, count(*)::bigint as total
    from public.events e
   where e.owner = p_owner
     and e.created_at >= p_since
   group by e.event_type;
$$;

revoke all on function public.event_stats(text, timestamptz) from public, anon, authenticated;
grant execute on function public.event_stats(text, timestamptz) to service_role;

-- Retención: borra eventos viejos. Ejecutar a mano, con pg_cron, o desde el SQL
-- editor de Supabase una vez por semana:
--   select prune_events(90);
create or replace function public.prune_events(days int default 90)
returns bigint
language plpgsql
as $$
declare
  deleted bigint;
begin
  delete from public.events
   where created_at < now() - (days || ' days')::interval;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- Para programarlo con pg_cron (Supabase > Database > Extensions > pg_cron):
--   select cron.schedule('prune-events', '0 3 * * *', $$select prune_events(90)$$);
