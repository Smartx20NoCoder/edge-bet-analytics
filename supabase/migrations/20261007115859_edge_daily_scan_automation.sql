alter table public.engine_settings
  add column if not exists scan_automation_enabled boolean not null default true,
  add column if not exists scan_automation_config jsonb not null default '{"timeframeHours":24,"maxMatches":100,"minOdds":1.5,"maxOdds":2.3,"trustedOnly":false,"betType":"all","winRateFloor":0.53,"drawRateCeil":0.35,"matchWinnerFloor":56,"over25Floor":55}'::jsonb,
  add column if not exists scan_automation_last_run timestamptz,
  add column if not exists scan_automation_status jsonb;
