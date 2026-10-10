import type { SupabaseClient } from "@supabase/supabase-js";

// Supabase can emit SIGNED_IN again when a tab regains focus. Keep the verified
// user's panel mounted while revalidating, but revoke access on sign-out/change.
export function watchAdminAccess(auth: SupabaseClient["auth"], onChange: (isAdmin: boolean) => void) {
  let active = true;
  let revision = 0;
  let userId: string | undefined;

  async function verify(currentRevision: number) {
    try {
      const { data, error } = await auth.getUser();
      if (!active || currentRevision !== revision) return;
      userId = error ? undefined : data.user?.id;
      onChange(!error && data.user?.app_metadata?.role === "admin");
    } catch {
      if (active && currentRevision === revision) {
        userId = undefined;
        onChange(false);
      }
    }
  }

  void verify(++revision);
  const { data } = auth.onAuthStateChange((event, session) => {
    if (!active) return;
    const currentRevision = ++revision;
    if (event === "SIGNED_OUT" || !session) {
      userId = undefined;
      onChange(false);
      return;
    }
    if (userId && userId !== session.user.id) {
      userId = undefined;
      onChange(false);
    }
    // Avoid calling the auth client inside its own event callback.
    setTimeout(() => {
      if (active && currentRevision === revision) void verify(currentRevision);
    }, 0);
  });
  return () => {
    active = false;
    revision++;
    data.subscription.unsubscribe();
  };
}
