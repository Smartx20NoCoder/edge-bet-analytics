
-- Analyses (scan runs)
CREATE TABLE public.analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date DATE NOT NULL DEFAULT CURRENT_DATE,
  league_id TEXT,
  league_name TEXT,
  matches_analyzed INT NOT NULL DEFAULT 0,
  predictions_generated INT NOT NULL DEFAULT 0,
  avg_confidence NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'completed',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID REFERENCES public.analyses(id) ON DELETE CASCADE,
  engine TEXT NOT NULL, -- 'corners' | 'match'
  prediction_type TEXT NOT NULL, -- 'over_6_5_corners' | 'match_winner' | 'double_chance' | 'asian_handicap' | 'over_1_5_goals'
  selection TEXT NOT NULL,
  match_id TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  league_id TEXT,
  league_name TEXT,
  kickoff TIMESTAMPTZ,
  confidence NUMERIC(5,2) NOT NULL,
  projected_corners NUMERIC(5,2),
  risk_level TEXT NOT NULL DEFAULT 'medium',
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.fixtures_cache (
  match_id TEXT PRIMARY KEY,
  league_id TEXT,
  league_name TEXT,
  home_team TEXT,
  away_team TEXT,
  kickoff TIMESTAMPTZ,
  raw JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.analysis_cache (
  match_id TEXT PRIMARY KEY,
  raw JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_predictions_analysis ON public.predictions(analysis_id);
CREATE INDEX idx_predictions_engine ON public.predictions(engine);
CREATE INDEX idx_predictions_kickoff ON public.predictions(kickoff);
CREATE INDEX idx_analyses_scan_date ON public.analyses(scan_date DESC);

ALTER TABLE public.analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixtures_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_cache ENABLE ROW LEVEL SECURITY;

-- Public read access (analytics terminal)
CREATE POLICY "public read analyses" ON public.analyses FOR SELECT USING (true);
CREATE POLICY "public read predictions" ON public.predictions FOR SELECT USING (true);
CREATE POLICY "public read fixtures_cache" ON public.fixtures_cache FOR SELECT USING (true);
CREATE POLICY "public read analysis_cache" ON public.analysis_cache FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies → only service role (server functions) can write.
