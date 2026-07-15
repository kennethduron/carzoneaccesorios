"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import {
  applyHistoricalReceivableImportBatch,
  assignHistoricalReceivableImportRow,
  cancelHistoricalReceivableImportRow,
  createHistoricalAccountsReceivableImportBatch,
  rollbackHistoricalReceivableImportBatch,
  updateHistoricalReceivableImportIdentity,
} from "@/services/supabase/accounts-receivable-import.service";
import { setImportBatchStatus } from "@/services/supabase/import-foundation.service";
import type { HistoricalReceivableImportActionState } from "@/types/accounts-receivable-import";

const initialError = "No se pudo procesar la importacion de cuentas por cobrar.";

function canImportReceivables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "receivables:import", profile.email);
}

function canAssignReceivables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "receivables:assign", profile.email);
}

function canApplyReceivables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return hasEffectivePermission(profile.role, profile.permissions, "receivables:apply", profile.email);
}

function canRollbackReceivables(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return (
    ["technical_owner", "business_owner"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "receivables:rollback", profile.email)
  );
}

function revalidateReceivableImportPaths(batchId?: string | null) {
  revalidatePath("/admin/cuentas-por-cobrar");
  revalidatePath("/admin/importaciones");
  revalidatePath("/cuenta");
  if (batchId) revalidatePath(`/admin/cuentas-por-cobrar?importBatch=${batchId}`);
}

export async function importHistoricalAccountsReceivableAction(
  _previousState: HistoricalReceivableImportActionState,
  formData: FormData,
): Promise<HistoricalReceivableImportActionState> {
  const profile = await requirePermission("admin:access");
  if (!canImportReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para importar cuentas por cobrar.", errors: ["Permiso insuficiente."] };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx.", errors: ["Selecciona un archivo Excel .xlsx."] };
  }

  await writeAuditLog({
    tableName: "import_batches",
    action: "historical_receivable_import.attempted",
    newData: { fileName: file.name, fileSize: file.size },
  });

  try {
    const result = await createHistoricalAccountsReceivableImportBatch(file, profile.id);
    await writeAuditLog({
      tableName: "import_batches",
      recordId: result.batchId,
      action: "historical_receivable_import.staged",
      newData: {
        fileName: file.name,
        rows: result.rows.length,
        errors: result.errors.length,
        status: result.status,
      },
    });
    revalidateReceivableImportPaths(result.batchId);

    if (result.errors.length > 0 || result.rows.some((row) => row.validationStatus === "invalid")) {
      return {
        ok: false,
        message: "El archivo fue guardado en staging con errores para revision.",
        errors: result.errors.length > 0 ? result.errors : ["Revisa las filas marcadas con error."],
        batchId: result.batchId,
      };
    }

    const pending = result.rows.filter((row) => row.assignmentStatus === "pending" || row.assignmentStatus === "suggested").length;
    return {
      ok: true,
      message: pending > 0 ? "Importacion validada. Hay filas pendientes de asignacion." : "Importacion validada y lista para aplicar.",
      errors: [],
      batchId: result.batchId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : initialError;
    await writeAuditLog({
      tableName: "import_batches",
      action: "historical_receivable_import.failed",
      newData: { fileName: file.name, error: message },
    });
    return { ok: false, message: initialError, errors: [message] };
  }
}

export async function assignHistoricalReceivableRowAction(rowId: string, customerId: string) {
  const profile = await requirePermission("admin:access");
  if (!canAssignReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para asignar clientes." };
  }

  try {
    await assignHistoricalReceivableImportRow(rowId, customerId);
    await writeAuditLog({
      tableName: "import_rows",
      recordId: rowId,
      action: "historical_receivable_import.customer_assigned",
      newData: { customerAssigned: true },
    });
    revalidateReceivableImportPaths();
    return { ok: true, message: "Cliente asignado y confirmado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo asignar el cliente." };
  }
}

export async function updateHistoricalReceivableIdentityAction(
  rowId: string,
  input: { email?: string; phone?: string; taxId?: string },
) {
  const profile = await requirePermission("admin:access");
  if (!canAssignReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para completar la identidad del cliente." };
  }

  try {
    await updateHistoricalReceivableImportIdentity(rowId, input);
    await writeAuditLog({
      tableName: "import_rows",
      recordId: rowId,
      action: "historical_receivable_import.identity_completed",
      newData: { identityCompleted: true },
    });
    revalidateReceivableImportPaths();
    return { ok: true, message: "Identidad guardada. Revisa el preview antes de confirmar." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo guardar la identidad." };
  }
}

export async function cancelHistoricalReceivableRowAction(rowId: string) {
  const profile = await requirePermission("admin:access");
  if (!canImportReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para cancelar filas en staging." };
  }

  try {
    await cancelHistoricalReceivableImportRow(rowId);
    await writeAuditLog({
      tableName: "import_rows",
      recordId: rowId,
      action: "historical_receivable_import.row_cancelled",
      newData: { cancelled: true },
    });
    revalidateReceivableImportPaths();
    return { ok: true, message: "Fila cancelada en staging." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo cancelar la fila." };
  }
}

export async function applyHistoricalReceivableBatchAction(batchId: string) {
  const profile = await requirePermission("admin:access");
  if (!canApplyReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para aplicar el lote." };
  }

  try {
    const summary = await applyHistoricalReceivableImportBatch(batchId);
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_receivable_import.batch_applied",
      newData: summary,
    });
    revalidateReceivableImportPaths(batchId);
    return { ok: true, message: `Importación confirmada. CxC creadas: ${summary.created_receivables.toLocaleString("es-HN")}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo aplicar el lote." };
  }
}

export async function cancelHistoricalReceivableBatchAction(batchId: string) {
  const profile = await requirePermission("admin:access");
  if (!canImportReceivables(profile)) {
    return { ok: false, message: "No tienes permiso para cancelar lotes." };
  }

  try {
    await setImportBatchStatus(batchId, "cancelled", { cancelled_from: "historical_accounts_receivable_import" });
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_receivable_import.batch_cancelled",
      newData: { cancelled: true },
    });
    revalidateReceivableImportPaths(batchId);
    return { ok: true, message: "Lote cancelado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo cancelar el lote." };
  }
}

export async function rollbackHistoricalReceivableBatchAction(batchId: string, reason: string) {
  const profile = await requirePermission("admin:access");
  if (!canRollbackReceivables(profile)) {
    return { ok: false, message: "Solo technical_owner o business_owner pueden revertir lotes aplicados." };
  }

  try {
    const result = await rollbackHistoricalReceivableImportBatch(batchId, reason.trim());
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "historical_receivable_import.batch_rolled_back",
      newData: { reason, ...result },
    });
    revalidateReceivableImportPaths(batchId);
    return { ok: true, message: "Rollback completado." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo revertir el lote." };
  }
}
