import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PosPermission } from "@/lib/auth/pos-permissions";

export async function hasDatabasePosPermission(permission: PosPermission) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("pos_permission_allowed", {
    permission_key: permission,
  });

  if (error) return false;
  return data === true;
}
