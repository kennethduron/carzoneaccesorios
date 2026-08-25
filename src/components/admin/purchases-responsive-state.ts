import type { AdminPurchase } from "@/types/purchases";

export type PurchaseStatusFilter = "active" | "draft" | "confirmed" | "cancelled" | "all";
export type PurchaseSelectionNotice = "invalid" | "hidden" | null;

const searchableStatusLabels: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  received: "Recibida",
  cancelled: "Cancelada",
  returned: "Devuelta",
};

export function normalizePurchaseSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function filterAdminPurchases(
  purchases: AdminPurchase[],
  input: { query: string; supplierId: string; status: PurchaseStatusFilter },
) {
  const needle = normalizePurchaseSearch(input.query.trim());

  return purchases.filter((purchase) => {
    if (input.status === "active" && ["cancelled", "returned"].includes(purchase.status)) return false;
    if (input.status !== "active" && input.status !== "all" && purchase.status !== input.status) return false;
    if (input.supplierId !== "all" && purchase.supplier_id !== input.supplierId) return false;
    if (!needle) return true;

    return normalizePurchaseSearch(
      [purchase.purchase_number, purchase.supplier_name, purchase.notes, searchableStatusLabels[purchase.status]]
        .filter(Boolean)
        .join(" "),
    ).includes(needle);
  });
}

export function resolveInitialPurchaseSelection(purchases: AdminPurchase[], requestedId: string | null) {
  if (requestedId) {
    const requestedPurchase = purchases.find((purchase) => purchase.id === requestedId);
    if (!requestedPurchase) return { selectedId: null, notice: "invalid" as PurchaseSelectionNotice };
    if (["cancelled", "returned"].includes(requestedPurchase.status)) {
      return { selectedId: null, notice: "hidden" as PurchaseSelectionNotice };
    }
    return { selectedId: requestedId, notice: null as PurchaseSelectionNotice };
  }

  const firstActivePurchase = purchases.find((purchase) => !["cancelled", "returned"].includes(purchase.status));
  return { selectedId: firstActivePurchase?.id ?? null, notice: null as PurchaseSelectionNotice };
}

export function isPurchaseReturnEligible(purchase: AdminPurchase) {
  return ["confirmed", "received", "returned"].includes(purchase.status);
}
