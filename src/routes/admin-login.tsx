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

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (data.user) {
        const role = (data.user.app_metadata as Record<string, unknown> | null)?.role;
        if (role === "admin") await navigate({ to: "/settings" });
      }
    }).catch(() => {
      // A failed session check should not prevent the login form from being used.
    });
  }, [navigate]);

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
        setError(authError?.message ?? "Unable to sign in");
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
          <span>Only a Edge Bet admin can access or change settings.</span>
        </div>

        <form onSubmit={signIn} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Email</label>
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Password</label>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </section>
  );
}
