CREATE TABLE public.engine_settings (
  id boolean PRIMARY KEY DEFAULT true,
  data_engine text NOT NULL DEFAULT 'isports',
  odds_api_key text,
  sport_keys text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_settings_singleton CHECK (id = true)
);

GRANT SELECT (id, data_engine, sport_keys, updated_at) ON public.engine_settings TO anon;
GRANT SELECT (id, data_engine, sport_keys, updated_at) ON public.engine_settings TO authenticated;
GRANT ALL ON public.engine_settings TO service_role;

ALTER TABLE public.engine_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read engine_settings" ON public.engine_settings FOR SELECT USING (true);

INSERT INTO public.engine_settings (id, data_engine) VALUES (true, 'isports');