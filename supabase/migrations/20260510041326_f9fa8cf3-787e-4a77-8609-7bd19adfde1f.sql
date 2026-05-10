CREATE TABLE public.api_usage (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  called_at timestamptz NOT NULL DEFAULT now(),
  endpoint text NOT NULL,
  date date GENERATED ALWAYS AS ((called_at AT TIME ZONE 'UTC')::date) STORED
);

CREATE INDEX idx_api_usage_date ON public.api_usage(date);

ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read api_usage" ON public.api_usage FOR SELECT USING (true);
CREATE POLICY "public insert api_usage" ON public.api_usage FOR INSERT WITH CHECK (true);