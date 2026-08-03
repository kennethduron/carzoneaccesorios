export type PosQuantityStock = {
  tracksInventory?: boolean;
  availableStock: number;
};

export type PosQuantityValidation =
  | { ok: true; quantity: number; maximum: number }
  | { ok: false; code: "POS_QUANTITY_INVALID" | "POS_INSUFFICIENT_STOCK"; maximum: number };

export function getPosMaximumQuantity(item: PosQuantityStock) {
  return item.tracksInventory === false ? 9999 : Math.max(0, Math.floor(item.availableStock));
}

export function validatePosQuantity(item: PosQuantityStock, requested: number): PosQuantityValidation {
  const maximum = getPosMaximumQuantity(item);
  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, code: "POS_QUANTITY_INVALID", maximum };
  }
  if (requested > maximum) {
    return { ok: false, code: "POS_INSUFFICIENT_STOCK", maximum };
  }
  return { ok: true, quantity: requested, maximum };
}
