import {createFileRoute} from '@tanstack/react-router';
import {runAutomaticResultsUpdate} from '@/lib/automatic-results.server';

export const Route = createFileRoute('/api/cron/update-results')({
  server: {handlers: {GET: async ({request}) => {
    const auth = request.headers.get('authorization');
    const secrets = [process.env.CRON_SECRET, process.env.RESULTS_SCHEDULE_SECRET].filter(Boolean);
    if (!secrets.some(secret => auth === `Bearer ${secret}`)) return new Response('Unauthorized', {status: 401});
    try {
      return Response.json({ok: true, job: 'update-results', automated: true, ...await runAutomaticResultsUpdate()},
        {headers: {'Cache-Control': 'no-store'}});
    } catch (error: any) {
      console.error('[cron:update-results] failed', error?.message ?? error);
      return Response.json({ok: false, job: 'update-results', error: error?.message ?? 'Results unavailable'}, {status: 500});
    }
  }}}});
