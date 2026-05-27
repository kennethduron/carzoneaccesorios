export type AdditionalFee = {
  label: string;
  amount: number;
};

export type FinancialBreakdown = {
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  additionalFees: AdditionalFee[];
  total: number;
};
