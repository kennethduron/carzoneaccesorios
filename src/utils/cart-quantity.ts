export const CART_MAX_QUANTITY = 10_000;

export type CartQuantityValidation =
  | { ok: true; quantity: number; maximum: number }
  | {
      ok: false;
      code: "QUANTITY_INVALID" | "QUANTITY_TOO_HIGH" | "STOCK_EXCEEDED" | "WHOLESALE_MINIMUM";
      message: string;
      maximum: number;
    };

export function parseCartQuantityDraft(rawValue: string) {
  const normalized = rawValue.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isSafeInteger(quantity) ? quantity : null;
}

export function validateCartQuantity(input: {
  requestedQuantity: number;
  availableStock: number;
  wholesaleMinimum: number;
  wholesaleMinimumApplies: boolean;
}): CartQuantityValidation {
  const maximum = Math.min(Math.max(0, Math.trunc(input.availableStock)), CART_MAX_QUANTITY);
  if (!Number.isSafeInteger(input.requestedQuantity) || input.requestedQuantity <= 0) {
    return { ok: false, code: "QUANTITY_INVALID", message: "Ingresa una cantidad entera mayor que cero.", maximum };
  }
  if (input.requestedQuantity > CART_MAX_QUANTITY) {
    return {
      ok: false,
      code: "QUANTITY_TOO_HIGH",
      message: `La cantidad máxima permitida es ${CART_MAX_QUANTITY.toLocaleString("es-HN")}.`,
      maximum,
    };
  }
  if (maximum <= 0 || input.requestedQuantity > maximum) {
    return {
      ok: false,
      code: "STOCK_EXCEEDED",
      message: maximum <= 0 ? "Este producto no tiene stock disponible." : `Solo hay ${maximum} unidades disponibles.`,
      maximum,
    };
  }
  const minimum = Math.max(1, Math.trunc(input.wholesaleMinimum));
  if (input.wholesaleMinimumApplies && input.requestedQuantity < minimum) {
    return {
      ok: false,
      code: "WHOLESALE_MINIMUM",
      message: `Este producto requiere un mínimo de ${minimum} unidades para compra mayorista.`,
      maximum,
    };
  }
  return { ok: true, quantity: input.requestedQuantity, maximum };
}
