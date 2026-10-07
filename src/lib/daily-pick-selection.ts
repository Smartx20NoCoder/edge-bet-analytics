export type DailyCandidate = { id: string; match_id: string | null; home_team: string; away_team: string; expected_value: number | null; kickoff: string; is_correct?: boolean | null };
const normalizeTeam = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(fc|cf|afc)\b/g, '').replace(/[^a-z0-9]/g, '');
export function fixtureKey(p: DailyCandidate): string {
  const home = normalizeTeam(p.home_team ?? '');
  const away = normalizeTeam(p.away_team ?? '');
  return home && away ? `${home}|${away}|${Math.floor(Date.parse(p.kickoff) / 60000)}` : String(p.match_id ?? p.id);
}
// No source preference: retain the highest eligible EV per real fixture.
export function selectDailyPair(picks: DailyCandidate[]) {
  const best = new Map<string, DailyCandidate>();
  for (const p of picks) {
    if (!Number.isFinite(p.expected_value) || Number(p.expected_value) < 0 || Number(p.expected_value) > .40) continue;
    const key = fixtureKey(p), current = best.get(key);
    if (!current || Number(p.expected_value) > Number(current.expected_value) || (p.expected_value === current.expected_value && p.id < current.id)) best.set(key, p);
  }
  const ranked = [...best.values()].sort((a,b) => Number(b.expected_value)-Number(a.expected_value) || a.id.localeCompare(b.id));
  return { single: ranked[0] ?? null, second: ranked[1] ?? null };
}
export function canRefreshDailyPair(lockedIds: Array<string | null>, picks: DailyCandidate[], now: number): boolean {
  const ids = lockedIds.filter((id): id is string => !!id);
  return ids.length > 0 && ids.every(id => {
    const pick = picks.find(p => p.id === id);
    return !!pick && pick.is_correct == null && Date.parse(pick.kickoff) > now;
  });
}
