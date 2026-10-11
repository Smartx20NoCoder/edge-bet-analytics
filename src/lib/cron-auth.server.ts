export function isCronAuthorized(request: Request): boolean {
  const secrets = [process.env.CRON_SECRET,process.env.RESULTS_SCHEDULE_SECRET].filter(Boolean);
  return secrets.some(secret=>request.headers.get("authorization")===`Bearer ${secret}`);
}
