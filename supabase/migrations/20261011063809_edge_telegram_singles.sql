-- Server-only configuration and delivery bookkeeping; never store bot tokens here.
create table public.edge_telegram_settings (
 id boolean primary key default true check (id),
 enabled boolean not null default false,
 chat_id text,
 title text,
 bot_username text,
 updated_at timestamptz not null default now(),
 check (not enabled or chat_id is not null)
);
create table public.edge_telegram_deliveries (
 chat_id text not null,
 day date not null,
 prediction_id uuid not null references public.predictions(id) on delete restrict,
 pick_snapshot jsonb not null,
 status text not null check (status in ('queued','sending','sent','editing','failed','uncertain')),
 message_id bigint,
 content_hash text,
 error text,
 updated_at timestamptz not null default now(),
 archived boolean not null default false,
 primary key (chat_id,day)
);
create index edge_telegram_delivery_updated on public.edge_telegram_deliveries(chat_id,updated_at desc);
alter table public.edge_telegram_settings enable row level security;
alter table public.edge_telegram_deliveries enable row level security;
revoke all on public.edge_telegram_settings, public.edge_telegram_deliveries from public, anon, authenticated;
grant select,insert,update,delete on public.edge_telegram_settings, public.edge_telegram_deliveries to service_role;
