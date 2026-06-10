export const defaultIncludedTaxRate = 0.15;

export function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function normalizeTaxRate(value: unknown, fallback = defaultIncludedTaxRate) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : fallback;
}

export function calculateIncludedTaxBreakdown(grossTotal: number, taxRate = defaultIncludedTaxRate) {
  const totalWithTax = roundMoney(grossTotal);
  const normalizedRate = normalizeTaxRate(taxRate);

  if (totalWithTax <= 0 || normalizedRate <= 0) {
    return {
      subtotalBeforeTax: totalWithTax,
      includedTax: 0,
      totalWithTax,
    };
  }

  const subtotalBeforeTax = roundMoney(totalWithTax / (1 + normalizedRate));
  const includedTax = roundMoney(totalWithTax - subtotalBeforeTax);

  return {
    subtotalBeforeTax,
    includedTax,
    totalWithTax,
  };
}
