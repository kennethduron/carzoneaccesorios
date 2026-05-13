"use server";

import { revalidatePath } from "next/cache";
import { requireStrictPermission } from "@/lib/auth/session";
import { cleanupOldOperationalLogs } from "@/services/supabase/admin-usage.service";

export async function cleanupLogsAction() {
  await requireStrictPermission("system:monitoring");
  await cleanupOldOperationalLogs(90);
  revalidatePath("/admin/uso");
}
