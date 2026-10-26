-- XYB schema
-- Ejecutar completo en Supabase > SQL Editor > New query > Run

create extension if not exists pgcrypto;

create table if not exists public.targets (
  user_id    text primary key,
  username   text,
  note       text,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id           bigserial primary key,
  event_type   text not null,          -- message | message_edit | message_delete | voice_* | presence
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

create index if not exists events_created_at_idx on public.events (created_at desc);
create index if not exists events_user_idx       on public.events (user_id, created_at desc);
create index if not exists events_type_idx       on public.events (event_type, created_at desc);
create index if not exists events_message_idx    on public.events (message_id, event_type);
create index if not exists events_guild_idx      on public.events (guild_id, created_at desc);

-- Cuentas del panel. El primer registro es admin y puede ver la key de
-- registro; los demás son usuarios. La contraseña va con scrypt + salt y el
-- HWID como sha256 (nunca en claro).
create table if not exists public.accounts (
  username         text primary key,
  role             text not null default 'user',   -- admin | user
  password_salt    text not null,
  password_hash    text not null,
  hwid_hash        text,                            -- sha256 del dispositivo vinculado
  hwid_label       text,
  session_version  integer not null default 0,      -- sube al cambiar pass o desvincular HWID
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz,
  last_ip          text
);

create index if not exists accounts_hwid_idx on public.accounts (hwid_hash);

-- RLS on, cero policies: solo la service_role key (la del bot) puede leer/escribir.
alter table public.targets  enable row level security;
alter table public.events   enable row level security;
alter table public.accounts enable row level security;

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
