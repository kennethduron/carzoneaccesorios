import type {
  CommerceSettings,
  DashboardCardSettings,
  InventoryBusinessSettings,
  OrderBusinessSettings,
  WholesaleBusinessSettings,
} from "@/types/settings";

export const defaultCommerceSettings: CommerceSettings = {
  free_shipping_threshold: 3000,
  standard_shipping_fee: 120,
  cash_on_delivery_percentage: 5,
  enable_cash_on_delivery_fee: true,
  first_wholesale_minimum: 10000,
};

export const defaultDashboardCardSettings: DashboardCardSettings = {
  sales_today: true,
  pending_orders: true,
  pending_payments: true,
  low_inventory: true,
  wholesale_requests: true,
  customers_attention: true,
  pending_invoices: true,
  bac_alerts: true,
  backup_cron_status: false,
};

export const defaultWholesaleBusinessSettings: WholesaleBusinessSettings = {
  wholesale_manual_approval: true,
  wholesale_purchases_enabled: true,
  wholesale_allow_repeat_without_minimum: true,
  wholesale_auto_suspend_inactive: false,
};

export const defaultOrderBusinessSettings: OrderBusinessSettings = {
  allow_bank_transfer: true,
  allow_cash_on_delivery: true,
  bac_card_status: "pending",
  send_order_confirmation_email: true,
  send_order_status_update_email: true,
  require_bank_reference: true,
  transfer_receipt_requirement: "optional",
};

export const defaultInventoryBusinessSettings: InventoryBusinessSettings = {
  low_stock_alerts_enabled: true,
  global_low_stock_threshold: 5,
  out_of_stock_catalog_mode: "show",
  stock_reservations_enabled: true,
  stock_reservation_minutes: 2880,
};

export function toPositiveMoney(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : fallback;
}

export function normalizeCommerceSettings(value: Partial<CommerceSettings> | null | undefined): CommerceSettings {
  return {
    free_shipping_threshold: toPositiveMoney(value?.free_shipping_threshold, defaultCommerceSettings.free_shipping_threshold),
    standard_shipping_fee: toPositiveMoney(value?.standard_shipping_fee, defaultCommerceSettings.standard_shipping_fee),
    cash_on_delivery_percentage: toPositiveMoney(
      value?.cash_on_delivery_percentage,
      defaultCommerceSettings.cash_on_delivery_percentage,
    ),
    enable_cash_on_delivery_fee: value?.enable_cash_on_delivery_fee ?? defaultCommerceSettings.enable_cash_on_delivery_fee,
    first_wholesale_minimum: toPositiveMoney(value?.first_wholesale_minimum, defaultCommerceSettings.first_wholesale_minimum),
  };
}

export function normalizeDashboardCards(value: unknown): DashboardCardSettings {
  const source = typeof value === "object" && value !== null ? (value as Partial<DashboardCardSettings>) : {};

  return Object.fromEntries(
    Object.entries(defaultDashboardCardSettings).map(([key, fallback]) => [
      key,
      typeof source[key as keyof DashboardCardSettings] === "boolean"
        ? source[key as keyof DashboardCardSettings]
        : fallback,
    ]),
  ) as DashboardCardSettings;
}

export function calculateCheckoutFees({
  subtotal,
  paymentMethod,
  settings,
}: {
  subtotal: number;
  paymentMethod: "Transferencia bancaria" | "Tarjeta" | "Efectivo" | "bank_transfer" | "card" | "cash";
  settings: CommerceSettings;
}) {
  const normalized = normalizeCommerceSettings(settings);
  const normalizedPaymentMethod =
    paymentMethod === "Transferencia bancaria" ? "bank_transfer" : paymentMethod === "Efectivo" ? "cash" : paymentMethod;
  const safeSubtotal = toPositiveMoney(subtotal, 0);
  const shippingFee = safeSubtotal >= normalized.free_shipping_threshold ? 0 : normalized.standard_shipping_fee;
  const cashOnDeliveryFee =
    normalizedPaymentMethod === "cash" && normalized.enable_cash_on_delivery_fee
      ? Math.round(safeSubtotal * (normalized.cash_on_delivery_percentage / 100) * 100) / 100
      : 0;

  return {
    shippingFee,
    cashOnDeliveryFee,
    totalFees: Math.round((shippingFee + cashOnDeliveryFee) * 100) / 100,
  };
}
