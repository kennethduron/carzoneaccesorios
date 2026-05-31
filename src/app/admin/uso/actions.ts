"use server";

import { revalidatePath } from "next/cache";
import { requireStrictPermission } from "@/lib/auth/session";
import { cleanupOldOperationalLogs, recordBackupReview } from "@/services/supabase/admin-usage.service";

export async function cleanupLogsAction() {
  await requireStrictPermission("technical:tools");
  await cleanupOldOperationalLogs(90);
  revalidatePath("/admin/uso");
}

export async function recordBackupReviewAction() {
  await requireStrictPermission("system:backups");
  await recordBackupReview();
  revalidatePath("/admin/uso");
}
