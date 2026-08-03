import type { PosDraftItem, PosSaleDraft } from "@/types/pos-drafts";

export function isPosDraftItemStockInsufficient(
  item: Pick<PosDraftItem, "tracksInventory" | "quantity" | "availableStock" | "stockStatus">,
) {
  return item.tracksInventory !== false
    && (item.quantity > item.availableStock || item.stockStatus === "insufficient");
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
