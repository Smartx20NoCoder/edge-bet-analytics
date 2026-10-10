import { z } from "zod";
export const MAX_SCAN_MATCHES=500;
export const MATCH_LIMIT_PRESETS=[20,40,60,80,100,200,500];
export const ScanConfig = z.object({
  timeframeHours: z.number().int().min(1).max(24).default(24),
  maxMatches: z.number().int().min(1).max(MAX_SCAN_MATCHES).default(MAX_SCAN_MATCHES),
  minOdds: z.number().min(1).max(10).default(1.5),
  maxOdds: z.number().min(1).max(20).default(2.3),
  trustedOnly: z.boolean().default(false),
  betType: z.enum(["all", "match_winner", "over_2_5_goals"]).default("all"),
  winRateFloor: z.number().min(0).max(1).default(0.53),
  drawRateCeil: z.number().min(0).max(1).default(0.35),
  matchWinnerFloor: z.number().min(0).max(100).default(56),
  over25Floor: z.number().min(0).max(100).default(55),
}).refine(c => c.maxOdds >= c.minOdds, "Maximum odds must be at least minimum odds");
export const DEFAULT_SCAN_CONFIG = ScanConfig.parse({});
export function watDay(now: Date) { return new Date(now.getTime() + 3600000).toISOString().slice(0, 10); }
export function cronScanParams(config: z.infer<typeof ScanConfig>, now: Date) {
  const day = watDay(now);
  const midnight = Date.parse(day + "T00:00:00+01:00") + 86400000;
  const hours = Math.min(config.timeframeHours, (midnight - now.getTime()) / 3600000);
  return new URLSearchParams(Object.entries({ ...config, timeframeHours: hours, date: day, engine: "combined", refresh: false }).map(([k,v]) => [k,String(v)]));
}
