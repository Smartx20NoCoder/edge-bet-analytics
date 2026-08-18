ALTER TABLE public.daily_best_picks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daily_best_picks TO anon;
GRANT SELECT ON public.daily_best_picks TO authenticated;
GRANT ALL ON public.daily_best_picks TO service_role;
CREATE POLICY "public read daily_best_picks" ON public.daily_best_picks FOR SELECT USING (true);