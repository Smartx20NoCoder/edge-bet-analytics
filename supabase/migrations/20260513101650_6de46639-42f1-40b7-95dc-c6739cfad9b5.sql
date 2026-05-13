DELETE FROM public.analyses a
WHERE NOT EXISTS (
  SELECT 1 FROM public.predictions p WHERE p.analysis_id = a.id
);