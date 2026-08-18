-- Einmalig im Supabase SQL-Editor ausführen.

create table if not exists public.tickets (
  id          text primary key,
  name        text not null,
  message     text,
  files       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  opened_at   timestamptz,
  complete    boolean not null default false,
  pushed      boolean not null default false
);

create index if not exists tickets_created_idx on public.tickets (created_at desc);
create index if not exists tickets_opened_idx  on public.tickets (opened_at);

-- Zugriff nur über den geheimen Service-Key der Netlify-Functions,
-- niemals direkt aus dem Browser:
alter table public.tickets enable row level security;
