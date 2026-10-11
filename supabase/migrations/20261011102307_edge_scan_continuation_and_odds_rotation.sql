-- Update only the exhausted key inside the latest saved list. A concurrent
-- key addition must never be overwritten by an in-flight quota response.
create or replace function public.mark_edge_odds_key_exhausted(p_key text)
returns void language sql security invoker set search_path = '' as $$
  update public.engine_settings
  set odds_api_keys=(select jsonb_agg(case when entry->>'key'=p_key then entry || jsonb_build_object('exhausted_at',now()) else entry end order by ordinal)
    from jsonb_array_elements(odds_api_keys) with ordinality as keys(entry,ordinal)),updated_at=now()
  where id=true and odds_api_keys is not null;
$$;
revoke all on function public.mark_edge_odds_key_exhausted(text) from public,anon,authenticated;
grant execute on function public.mark_edge_odds_key_exhausted(text) to service_role;

-- Reuse the existing private scheduled-request template and vault reference;
-- no secret is read by the client or embedded in this migration.
do $$
declare request_template text;
begin
  select command into request_template from cron.job where jobname='edge_bet_results_every_four_hours';
  if request_template is null or request_template not like '%/api/cron/update-results%' then
    raise exception 'The authenticated results schedule template is unavailable';
  end if;
  perform cron.schedule('edge_bet_scan_continuation','*/5 9-22 * * *',replace(request_template,'/api/cron/update-results','/api/cron/auto-scan'));
end;
$$;
notify pgrst,'reload schema';
