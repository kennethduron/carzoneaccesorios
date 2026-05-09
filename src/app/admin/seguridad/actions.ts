"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { BackupType } from "@/types/security";
import { cleanText } from "@/utils/validation";

type SecurityMutationResult = {
  ok: boolean;
  message: string;
};

export async function requestBackupAction(
  backupType: BackupType,
  notes: string,
): Promise<SecurityMutationResult> {
  const profile = await requirePermission("settings:manage");

  const allowedTypes: BackupType[] = ["manual", "scheduled", "pre_deploy"];
  if (!allowedTypes.includes(backupType)) {
    return { ok: false, message: "Tipo de backup no valido." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("backup_logs")
    .insert({
      requested_by: profile.id,
      backup_type: backupType,
      status: "requested",
      notes: cleanText(notes) || "Backup solicitado desde panel de seguridad.",
    })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "backup_logs",
    recordId: data.id,
    action: "backup.requested",
    newData: { backupType },
  });

  revalidatePath("/admin/seguridad");
  return {
    ok: true,
    message: "Solicitud de backup registrada. Ejecuta el respaldo desde Supabase o tu tarea programada.",
  };
}
