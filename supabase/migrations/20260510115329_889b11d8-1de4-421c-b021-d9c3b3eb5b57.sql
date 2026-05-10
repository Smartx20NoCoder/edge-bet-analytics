CREATE TABLE public.api_key_status (
  key_index integer PRIMARY KEY,
  exhausted_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_key_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read api_key_status"
  ON public.api_key_status FOR SELECT
  USING (true);

INSERT INTO public.api_key_status (key_index, active) VALUES (1, true), (2, true);