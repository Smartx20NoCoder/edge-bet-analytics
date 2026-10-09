-- Provision RESULTS_SCHEDULE_SECRET in Vercel production and the same value
-- as edge_results_schedule_secret in Supabase Vault before running this file.
-- UTC schedule: 03:15, 07:15, 11:15, 15:15, 19:15, 23:15 WAT.
select cron.schedule('edge_bet_results_every_four_hours', '15 2,6,10,14,18,22 * * *', $$
  select net.http_get(
    url := 'https://edge-bet-analytics.vercel.app/api/cron/update-results',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='edge_results_schedule_secret')),
    timeout_milliseconds := 300000
  ) where (select results_automation_enabled from public.engine_settings where id=true);
$$);
