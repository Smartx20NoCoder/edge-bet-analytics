import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LockKeyhole, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/admin-login")({
  head: () => ({
    meta: [
      { title: "Admin Login · BetEdge AI" },
      { name: "description", content: "Secure administrator login for BetEdge AI settings." },
    ],
  }),
  component: AdminLogin,
});

function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [providerChecked, setProviderChecked] = useState(false);
  const [code, setCode] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    let active = true;
    let recoveryFlow = window.location.hash.includes("type=recovery");
    if (recoveryFlow) setRecovering(true);
    async function checkAccess() {
      const { data } = await supabase.auth.getUser();
      if (!active || !data.user || recoveryFlow) return;
      if (data.user.app_metadata?.role === "admin") await navigate({ to: "/settings" });
      else {
        await supabase.auth.signOut();
        if (active) setError("This account is not authorized for administrator access.");
      }
    }
    checkAccess().catch(() => {});
    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        recoveryFlow = true;
        setRecovering(true);
        setNotice("Choose a new password for your administrator account.");
        return;
      }
      if (event === "SIGNED_IN") queueMicrotask(() => { checkAccess().catch(() => {}); });
    });
    fetch('https://retwtdomgshqqdtqogei.supabase.co/auth/v1/settings', {
      headers: { apikey: 'sb_publishable_EgbvacsOIWAv7OLKRbsWMA_HZjulUKG' },
    }).then(r => r.ok ? r.json() : Promise.reject()).then(settings => {
      if (active) setGoogleEnabled(settings.external?.google === true);
    }).catch(() => {}).finally(() => { if (active) setProviderChecked(true); });
    return () => { active = false; subscription.subscription.unsubscribe(); };
  }, [navigate]);

  async function emailLink() {
    if (!email.trim()) { setError("Enter your administrator email first."); return; }
    setLoading(true); setError(null); setNotice(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: "https://edge-bet-analytics.vercel.app/admin-login" },
      });
      if (error) throw error;
      setNotice("Check your email for the sign-in link. If your email contains a code, enter it below. Only an existing administrator account has settings access.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to send sign-in email.";
      setError(message.toLowerCase().includes("signup") ? "Email-link login is for the existing administrator account. Check that you entered its registered email address." : message);
    }
    finally { setLoading(false); }
  }

  async function forgotPassword() {
    if (!email.trim()) { setError("Enter your registered administrator email first."); return; }
    setLoading(true); setError(null); setNotice(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: "https://edge-bet-analytics.vercel.app/admin-login",
      });
      if (error) throw error;
      setNotice("If this is your registered account, check your inbox and spam folder for a password-reset email. Open its link and choose a new password in the app.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to request password recovery."); }
    finally { setLoading(false); }
  }

  async function saveRecoveredPassword(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    if (newPassword !== confirmPassword) { setError("The passwords do not match."); return; }
    setLoading(true);
    try {
      const { data, error: userError } = await supabase.auth.getUser();
      if (userError || data.user?.app_metadata?.role !== "admin") throw new Error("Open a valid password-reset link for the administrator account first.");
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword(""); setConfirmPassword(""); setRecovering(false);
      // Remove the spent recovery fragment before entering settings.
      window.history.replaceState(null, "", window.location.pathname);
      await navigate({ to: "/settings" });
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update your password."); }
    finally { setLoading(false); }
  }

  async function verifyCode() {
    setLoading(true); setError(null);
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (error) throw error;
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to verify sign-in code."); }
    finally { setLoading(false); }
  }

  async function googleSignIn() {
    setLoading(true); setError(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google", options: { redirectTo: `${window.location.origin}/admin-login` },
      });
      if (error) throw error;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect to Google sign-in.");
      setLoading(false);
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (authError || !data.session || !data.user) {
        setError(authError?.code === "invalid_credentials" ? "Email or password did not match. Use the registered administrator email, or choose Forgot password below." : authError?.message ?? "Unable to sign in");
        setLoading(false);
        return;
      }

      const role = (data.user.app_metadata as Record<string, unknown> | null)?.role;
      if (role !== "admin") {
        await supabase.auth.signOut();
        setError("This account is not authorized for administrator access.");
        setLoading(false);
        return;
      }

      await navigate({ to: "/settings" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unable to connect to the authentication service.";
      setError(
        message.toLowerCase().includes("failed to fetch")
          ? "Unable to connect to the authentication service. Please check your connection and try again."
          : message,
      );
      setLoading(false);
    }
  }

  return (
    <section className="min-h-[70vh] flex items-center justify-center px-4 py-12">
      <div className="glass rounded-2xl p-6 sm:p-8 w-full max-w-md space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl border border-neon/30 bg-neon/10 flex items-center justify-center">
            <LockKeyhole className="h-5 w-5 text-neon" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Administrator login</h1>
            <p className="text-xs text-muted-foreground">BetEdge AI settings are restricted.</p>
          </div>
        </div>

        <div className="flex items-start gap-2 text-xs text-muted-foreground rounded-lg border border-border/60 p-3">
          <ShieldCheck className="h-4 w-4 text-neon shrink-0 mt-0.5" />
          <span>Only an Edge Bet admin can access or change settings.</span>
        </div>

        {recovering ? <form onSubmit={saveRecoveredPassword} className="space-y-4">
          <p className="text-sm text-muted-foreground">Set your new administrator password.</p>
          <label htmlFor="new-password" className="text-xs font-medium">New password</label>
          <Input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
          <label htmlFor="confirm-password" className="text-xs font-medium">Confirm new password</label>
          <Input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
          <Button type="submit" className="w-full" disabled={loading}>{loading ? "Saving…" : "Save new password"}</Button>
        </form> : <>
        <form onSubmit={signIn} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="admin-email" className="text-xs font-medium">Email</label>
            <Input id="admin-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="admin-password" className="text-xs font-medium">Password</label>
            <Input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="space-y-3 border-t border-border/60 pt-4">
          <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={forgotPassword}>Forgot password?</Button>
          <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={emailLink}>Email me a sign-in link</Button>
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
          {notice && <div className="flex gap-2">
            <Input aria-label="Email sign-in code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="Code, if included in email" />
            <Button type="button" disabled={loading || !code.trim()} onClick={verifyCode}>Verify</Button>
          </div>}
          <Button type="button" variant="outline" className="w-full" disabled={loading || !googleEnabled} onClick={googleSignIn}>Continue with Google</Button>
          {providerChecked && !googleEnabled && <p className="text-xs text-muted-foreground">Google sign-in needs to be enabled for this app. Use email and password or an email sign-in link for now.</p>}
        </div>
        </>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  );
}
