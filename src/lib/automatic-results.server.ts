import {supabaseAdmin} from '@/integrations/supabase/client.server';
import {updateAllPendingResultsInternal} from './predictions.functions';

export async function runAutomaticResultsUpdate() {
  const db = supabaseAdmin as any;
  const {data: settings, error} = await db.from('engine_settings')
    .select('results_automation_enabled').eq('id', true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!settings?.results_automation_enabled) return {skipped: true as const, reason: 'automation_disabled'};
  const {data: runId, error: claimError} = await db.rpc('claim_edge_results_update');
  if (claimError) throw new Error(claimError.message);
  if (!runId) return {skipped: true as const, reason: 'recent_check_or_already_running'};
  const now = new Date().toISOString();
  try {
    // Wait 110 minutes after kickoff. The providers still must confirm FT or a
    // final void status; this delay alone never settles a prediction.
    const result = await updateAllPendingResultsInternal(undefined, {automatic: true});
    const finished = new Date().toISOString();
    const {error: finishError} = await db.from('results_update_state')
      .update({lease_until: finished, last_finished_at: finished, summary: result})
      .eq('id', true).eq('run_id', runId);
    if (finishError) throw new Error(finishError.message);
    const {error: markError} = await db.from('engine_settings')
      .update({results_automation_last_run: now, updated_at: finished}).eq('id', true);
    if (markError) throw new Error(markError.message);
    return {skipped: false as const, ...result};
  } catch (error) {
    await db.from('results_update_state').update({lease_until: new Date().toISOString(),
      summary: {failed: true}}).eq('id', true).eq('run_id', runId);
    throw error;
  }
}
