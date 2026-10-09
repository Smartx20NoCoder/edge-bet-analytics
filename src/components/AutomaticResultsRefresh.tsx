import {useEffect, useRef, useState} from 'react';
import {useServerFn} from '@tanstack/react-start';
import {useQueryClient} from '@tanstack/react-query';
import {adminAccessToken, useAdminAccess} from '@/lib/admin-session';
import {refreshResultsOnOpen} from '@/lib/results-automation.functions';

export function AutomaticResultsRefresh() {
  const isAdmin = useAdminAccess();
  const refresh = useServerFn(refreshResultsOnOpen);
  const qc = useQueryClient();
  const running = useRef(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!isAdmin) {setMessage(''); return;}
    let active = true;
    async function check() {
      if (document.visibilityState !== 'visible' || running.current) return;
      running.current = true;
      if (active) setMessage('Checking saved match results…');
      try {
        const result = await refresh({data: {accessToken: await adminAccessToken()}});
        if (!active) return;
        if (result.skipped) setMessage(result.reason === 'automation_disabled' ? '' : 'Automatic results: checked recently or an update is already running.');
        else {
          setMessage(`Results updated: ${result.updated} · ${result.stillPending} due matches awaiting confirmed results.`);
          await qc.invalidateQueries();
        }
      } catch {
        if (active) setMessage('Automatic result check unavailable. Saved records are intact; use Update Results to retry.');
      } finally {running.current = false;}
    }
    void check();
    const timer = window.setInterval(() => {void check();}, 4*60*60*1000);
    const onReturn = () => {void check();};
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {active = false; window.clearInterval(timer); window.removeEventListener('focus', onReturn); document.removeEventListener('visibilitychange', onReturn);};
  }, [isAdmin, refresh, qc]);
  return isAdmin && message ? <p role="status" className="mx-auto w-full max-w-6xl px-3 sm:px-4 lg:px-6 pt-3 text-xs text-muted-foreground">{message}</p> : null;
}
