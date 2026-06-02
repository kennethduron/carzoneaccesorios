import type { AppRole } from "@/types/auth";
import type { NotificationPreference } from "@/types/notifications";

export const accountantNotificationTypes = new Set([
  "invoice.created",
  "invoice.cancelled",
  "fiscal.cai_expiring",
  "fiscal.cai_expired",
  "fiscal.range_low",
  "fiscal.invoice_error",
  "fiscal.correlative_invalid",
  "fiscal.report_ready",
]);

export const warehouseNotificationTypes = new Set([
  "reservation.expired_review_required",
  "reservation.expiring_soon",
  "reservation.extended",
  "reservation.released",
  "order.ready_to_prepare",
  "order.logistics_review",
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.critical_low_stock",
]);

export function isAccountantNotificationType(notificationType: string) {
  return accountantNotificationTypes.has(notificationType);
}

export function isWarehouseNotificationType(notificationType: string) {
  return warehouseNotificationTypes.has(notificationType);
}

export function canRoleReceiveNotificationType(role: AppRole, notificationType: string) {
  if (role === "contadora") {
    return isAccountantNotificationType(notificationType);
  }

  if (role === "bodega") {
    return isWarehouseNotificationType(notificationType);
  }

  return true;
}

export function filterPreferencesForRole<T extends Pick<NotificationPreference, "notification_type">>(
  preferences: T[],
  role: AppRole,
) {
  if (role === "contadora") {
    return preferences.filter((preference) => isAccountantNotificationType(preference.notification_type));
  }

  if (role === "bodega") {
    return preferences.filter((preference) => isWarehouseNotificationType(preference.notification_type));
  }

  return preferences;
}
