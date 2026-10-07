import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
export async function adminAccessToken() {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Administrator login required");
  return data.session.access_token;
}
export function useAdminAccess() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    const check = async () => {
      const { data } = await supabase.auth.getUser();
      if (active) setIsAdmin(data.user?.app_metadata?.role === "admin");
    };
    void check();
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (active) setIsAdmin(false);
      setTimeout(() => { if (active) void check(); }, 0);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  return isAdmin;
}
