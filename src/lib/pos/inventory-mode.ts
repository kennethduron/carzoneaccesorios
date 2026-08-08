import type { PosDraftItem, PosSaleDraft } from "@/types/pos-drafts";
import type { PosInventorySnapshot } from "@/types/point-of-sale";

export function isPosDraftItemStockInsufficient(
  item: Pick<PosDraftItem, "tracksInventory" | "quantity" | "availableStock" | "stockStatus">,
) {
  return item.tracksInventory !== false
    && (item.availableStock === null
      || item.quantity > item.availableStock
      || item.stockStatus === "insufficient");
}

export function applyPosInventorySnapshotsToItems(
  items: readonly PosDraftItem[],
  snapshots: ReadonlyMap<string, PosInventorySnapshot>,
): PosDraftItem[] {
  return items.map((item) => {
    const snapshot = snapshots.get(item.productId);
    if (!snapshot) return item;
    if (!snapshot.tracksInventory) {
      return {
        ...item,
        tracksInventory: false,
        physicalStock: null,
        reservedStock: null,
        availableStock: null,
        hasActiveReservations: false,
        stockObservedAt: snapshot.stockObservedAt,
        stockStatus: "available" as const,
        validationStatus: item.costFloorValidated ? "valid" as const : "warning" as const,
      };
    }
    return {
      ...item,
      tracksInventory: true,
      physicalStock: snapshot.physicalStock,
      reservedStock: snapshot.reservedStock,
      availableStock: snapshot.availableStock,
      hasActiveReservations: snapshot.hasActiveReservations,
      stockObservedAt: snapshot.stockObservedAt,
      stockStatus: snapshot.availableStock === null || item.quantity > snapshot.availableStock
        ? "insufficient" as const
        : "available" as const,
    };
  });
}

export function applyPosDraftInventorySnapshots(
  draft: PosSaleDraft,
  snapshots: ReadonlyMap<string, PosInventorySnapshot>,
): PosSaleDraft {
  return {
    ...draft,
    items: applyPosInventorySnapshotsToItems(draft.items, snapshots),
  };
}

export function applyPosDraftInventoryModes(
  draft: PosSaleDraft,
  modes: ReadonlyMap<string, boolean>,
): PosSaleDraft {
  const items = draft.items.map((item) => {
    const tracksInventory = modes.get(item.productId) ?? true;
    if (tracksInventory) return { ...item, tracksInventory };
    return {
      ...item,
      tracksInventory,
      physicalStock: null,
      reservedStock: null,
      availableStock: null,
      hasActiveReservations: false,
      stockStatus: "available" as const,
      validationStatus: item.costFloorValidated ? "valid" as const : "warning" as const,
    };
  });
  const hasWarning = items.some((item) => item.validationStatus !== "valid");
  return {
    ...draft,
    items,
    validationStatus: hasWarning ? "warning" : "valid",
    validationMessages: hasWarning ? draft.validationMessages : [],
  };
}
