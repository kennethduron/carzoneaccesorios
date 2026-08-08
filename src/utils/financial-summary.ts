import type { AdditionalFee, FinancialBreakdown } from "@/types/financial";

export function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function toMoney(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? roundMoney(number) : 0;
}

export function normalizeAdditionalFees(value: unknown): AdditionalFee[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const source = item as { label?: unknown; name?: unknown; amount?: unknown; total?: unknown; category?: unknown };
      const amount = toMoney(source.amount ?? source.total);
      if (amount <= 0) {
        return null;
      }

      const category = source.category === "additional_charge" || source.category === "other_charge"
        ? source.category
        : undefined;
      return {
        label: String(source.label ?? source.name ?? "Otros cargos").trim() || "Otros cargos",
        amount,
        ...(category ? { category } : {}),
      };
    })
    .filter(Boolean) as AdditionalFee[];
}

export function additionalFeesTotal(additionalFees: AdditionalFee[] | unknown) {
  return normalizeAdditionalFees(additionalFees).reduce((sum, fee) => roundMoney(sum + fee.amount), 0);
}

export function calculateFinancialTotal(input: Omit<FinancialBreakdown, "total">) {
  return roundMoney(
    toMoney(input.subtotal) +
      toMoney(input.tax) +
      toMoney(input.shippingFee) +
      toMoney(input.cashOnDeliveryFee) +
      toMoney(input.smallOrderFee) +
      additionalFeesTotal(input.additionalFees) -
      toMoney(input.discountTotal),
  );
}

export function normalizeFinancialBreakdown(input: Partial<FinancialBreakdown>): FinancialBreakdown {
  const additionalFees = normalizeAdditionalFees(input.additionalFees);
  const breakdown = {
    subtotal: toMoney(input.subtotal),
    tax: toMoney(input.tax),
    shippingFee: toMoney(input.shippingFee),
    cashOnDeliveryFee: toMoney(input.cashOnDeliveryFee),
    smallOrderFee: toMoney(input.smallOrderFee),
    discountTotal: toMoney(input.discountTotal),
    additionalFees,
    total: toMoney(input.total),
  };

  return {
    ...breakdown,
    total: breakdown.total || calculateFinancialTotal(breakdown),
  };
}

export function financialDifference(input: FinancialBreakdown) {
  return roundMoney(input.total - calculateFinancialTotal(input));
}
