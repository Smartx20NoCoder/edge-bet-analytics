import { useEffect, useState } from "react";
import { watchAdminAccess } from "@/lib/admin-access";
import { supabase } from "@/integrations/supabase/client";
export async function adminAccessToken() {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Administrator login required");
  return data.session.access_token;
}
export function useAdminAccess() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => watchAdminAccess(supabase.auth, setIsAdmin), []);
  return isAdmin;
}
