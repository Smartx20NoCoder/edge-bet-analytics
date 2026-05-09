ALTER TABLE public.predictions
  ADD COLUMN IF NOT EXISTS home_score integer,
  ADD COLUMN IF NOT EXISTS away_score integer,
  ADD COLUMN IF NOT EXISTS total_corners integer,
  ADD COLUMN IF NOT EXISTS ft_status text,
  ADD COLUMN IF NOT EXISTS is_correct boolean,
  ADD COLUMN IF NOT EXISTS results_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_predictions_match_id ON public.predictions(match_id);
CREATE INDEX IF NOT EXISTS idx_predictions_analysis_id ON public.predictions(analysis_id);
CREATE INDEX IF NOT EXISTS idx_analyses_scan_date ON public.analyses(scan_date DESC);