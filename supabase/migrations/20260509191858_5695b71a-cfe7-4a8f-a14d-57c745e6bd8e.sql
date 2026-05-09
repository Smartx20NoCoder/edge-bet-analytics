DELETE FROM public.predictions WHERE prediction_type IN ('btts', 'over_2_5_goals');

DELETE FROM public.predictions WHERE prediction_type <> 'match_winner' AND confidence::numeric < 75;

DELETE FROM public.predictions p
USING public.predictions q
WHERE p.analysis_id = q.analysis_id
  AND p.match_id = q.match_id
  AND p.analysis_id IS NOT NULL
  AND p.match_id IS NOT NULL
  AND (
    q.confidence::numeric > p.confidence::numeric
    OR (q.confidence::numeric = p.confidence::numeric AND q.id > p.id)
  );

DELETE FROM public.analyses WHERE predictions_generated = 0;