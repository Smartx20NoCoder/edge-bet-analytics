alter table public.edge_telegram_deliveries add column if not exists retry_at timestamptz;
create table if not exists public.edge_telegram_archives(
 chat_id text primary key,state text not null check(state in ('queued','running','complete','paused')),
 cursor date,through_day date not null,processed integer not null default 0,
 run_id uuid,lease_until timestamptz,next_attempt_at timestamptz,error text,
 updated_at timestamptz not null default now()
);
alter table public.edge_telegram_archives enable row level security;
revoke all on public.edge_telegram_archives from public,anon,authenticated;
grant select,insert,update,delete on public.edge_telegram_archives to service_role;
do $$ declare request_template text; begin
 select command into request_template from cron.job where jobname='edge_bet_results_every_four_hours';
 if request_template is null then raise exception 'Authenticated request schedule is missing'; end if;
 perform cron.schedule('edge_bet_telegram_history','* * * * *',replace(request_template,'/api/cron/update-results','/api/cron/auto-scan?job=telegram-history'));
end $$;
notify pgrst,'reload schema';
