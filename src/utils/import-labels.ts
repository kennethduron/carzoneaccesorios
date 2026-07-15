import type { ImportBatchStatus, ImportModule } from "@/types/import-foundation";

export function importModuleLabel(module: ImportModule) {
  return module === "accounts_receivable" ? "Cuentas por cobrar" : "Cuentas por pagar";
}

export const importBatchStatusLabels: Record<ImportBatchStatus, string> = {
  uploaded: "Cargado",
  validating: "Validando",
  validated: "Validado",
  pending_assignment: "Pendiente de asignación",
  ready: "Listo para aplicar",
  applied: "Aplicado",
  cancelled: "Cancelado",
  rolled_back: "Revertido",
  failed: "Fallido",
};
