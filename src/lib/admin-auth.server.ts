import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { setResponseHeaders, setResponseStatus } from "@tanstack/react-start/server";

export async function requireAdmin(accessToken: string): Promise<{ id: string; email: string | null }> {
  if (!accessToken || accessToken.length < 20) {
    setResponseStatus(401);
    throw new Error("Authentication required");
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) {
    setResponseStatus(401);
    throw new Error("Invalid or expired authentication session");
  }

  const role = (data.user.app_metadata as Record<string, unknown> | null)?.role;
  if (role !== "admin") {
    setResponseStatus(403);
    throw new Error("Administrator access required");
  }

  setResponseHeaders(new Headers({ "Cache-Control": "private, no-store", Vary: "Authorization" }));
  return { id: data.user.id, email: data.user.email ?? null };
}
