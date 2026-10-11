/** Group saved batches by scan calendar day in WAT, keeping each data source separate. */
export function groupHistoryDays(analyses: any[]): any[] {
  const groups = new Map<string, any>();
  for (const a of analyses) {
    const day = new Date(Date.parse(a.created_at) + 3600000).toISOString().slice(0, 10);
    const id = `${day}:${a.data_engine ?? 'unknown'}`;
    let g = groups.get(id);
    if (!g) {
      g = { ...a, id, day, analysis_ids: [], batch_count: 0, matches_analyzed: 0,
        predictions_generated: 0, score_total: 0, score_won: 0, score_pending: 0,
        matching_count: 0, positive_ev_count: 0, confidence_sum: 0, confidence_weight: 0 };
      groups.set(id, g);
    }
    g.analysis_ids.push(a.id);
    g.batch_count++;
    for (const key of ['matches_analyzed', 'predictions_generated', 'score_total', 'score_won', 'score_pending', 'matching_count', 'positive_ev_count']) {
      g[key] += Number(a[key] ?? 0);
    }
    if (g.league_scope !== a.league_scope) g.league_scope = null;
    if (a.avg_confidence != null && a.predictions_generated > 0) {
      g.confidence_sum += Number(a.avg_confidence) * a.predictions_generated;
      g.confidence_weight += a.predictions_generated;
    }
  }
  return [...groups.values()].map(({ confidence_sum, confidence_weight, ...g }) => ({
    ...g, avg_confidence: confidence_weight ? Math.round(confidence_sum / confidence_weight * 10) / 10 : null,
  })).sort((a, b) => b.day.localeCompare(a.day) || String(a.data_engine).localeCompare(String(b.data_engine)));
}
