-- Private service-role state for result checks shared by cron and admin opening.
create table if not exists public.results_update_state (
  id boolean primary key default true check (id),
  run_id uuid,
  lease_until timestamptz not null default '-infinity',
  last_started_at timestamptz,
  last_finished_at timestamptz,
  summary jsonb
);
alter table public.results_update_state enable row level security;
revoke all on public.results_update_state from public, anon, authenticated;
grant select, insert, update on public.results_update_state to service_role;
insert into public.results_update_state(id) values(true) on conflict do nothing;

create or replace function public.claim_edge_results_update()
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare claimed uuid;
begin
  update public.results_update_state
  set run_id=gen_random_uuid(),lease_until=now()+interval '8 minutes',last_started_at=now()
  where id=true and lease_until<=now()
    and (last_started_at is null or last_started_at<=now()-interval '15 minutes')
  returning run_id into claimed;
  return claimed;
end;
$$;
revoke all on function public.claim_edge_results_update() from public, anon, authenticated;
grant execute on function public.claim_edge_results_update() to service_role;

update public.engine_settings
set results_automation_interval=case when results_automation_enabled then '4h' else 'off' end,
    updated_at=now()
where id=true;
notify pgrst,'reload schema';
