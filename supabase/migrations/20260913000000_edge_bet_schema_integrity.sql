-- Edge Bet schema integrity migration.
-- Non-destructive: restores schema objects required by the current Edge Bet source.

ALTER TABLE public.predictions
  ADD COLUMN IF NOT EXISTS market_odds numeric,
  ADD COLUMN IF NOT EXISTS model_probability numeric,
  ADD COLUMN IF NOT EXISTS expected_value numeric;

ALTER TABLE public.api_key_status
  ADD COLUMN IF NOT EXISTS api_key text;

ALTER TABLE public.engine_settings
  ADD COLUMN IF NOT EXISTS odds_api_keys jsonb;

CREATE TABLE IF NOT EXISTS public.daily_best_picks (
  day date PRIMARY KEY,
  locked_at timestamptz NOT NULL DEFAULT now(),
  single_prediction_id uuid REFERENCES public.predictions(id),
  combo_prediction_id_1 uuid REFERENCES public.predictions(id),
  combo_prediction_id_2 uuid REFERENCES public.predictions(id)
);

ALTER TABLE public.daily_best_picks ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.daily_best_picks TO anon;
GRANT SELECT ON public.daily_best_picks TO authenticated;
GRANT ALL ON public.daily_best_picks TO service_role;

DROP POLICY IF EXISTS "public read daily_best_picks" ON public.daily_best_picks;
CREATE POLICY "public read daily_best_picks"
  ON public.daily_best_picks FOR SELECT USING (true);

GRANT ALL ON public.engine_settings TO service_role;
GRANT SELECT (id, data_engine, sport_keys, updated_at) ON public.engine_settings TO anon;
GRANT SELECT (id, data_engine, sport_keys, updated_at) ON public.engine_settings TO authenticated;
