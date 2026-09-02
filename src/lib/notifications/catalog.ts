import type { AppRole } from "@/types/auth";
import type { NotificationModule, NotificationSeverity } from "@/types/notifications";

export type NotificationCatalogItem = {
  type: string;
  module: NotificationModule;
  label: string;
  defaultSeverity: NotificationSeverity;
  defaultRoles: AppRole[];
  emailDefault: boolean;
  technicalOnly?: boolean;
};

export const technicalServiceAccountEmail = process.env.TECHNICAL_SERVICE_ACCOUNT_EMAIL ?? "";

export const notificationCatalog = [
  { type: "order.created", module: "pedidos", label: "Nuevo pedido", defaultSeverity: "info", defaultRoles: ["technical_owner", "business_owner", "admin"], emailDefault: true },
  { type: "order.cancelled", module: "pedidos", label: "Pedido cancelado", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "order.no_progress", module: "pedidos", label: "Pedido sin avance", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "vendedor", "soporte"], emailDefault: false },
  { type: "order.delivered_unpaid", module: "pedidos", label: "Pedido entregado sin pago confirmado", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "payment.pending", module: "pagos", label: "Pago pendiente", defaultSeverity: "info", defaultRoles: ["business_owner", "admin"], emailDefault: false },
  { type: "payment.transfer_review", module: "pagos", label: "Transferencia en revisión", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "payment.rejected", module: "pagos", label: "Pago rechazado", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "payment.confirmed", module: "pagos", label: "Pago confirmado", defaultSeverity: "info", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "payment.overdue", module: "pagos", label: "Pago pendiente vencido", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "commercial_credit.enabled", module: "pagos", label: "Crédito comercial habilitado", defaultSeverity: "info", defaultRoles: [], emailDefault: false },
  { type: "credit.due_7_days", module: "pagos", label: "Crédito vence en 7 días", defaultSeverity: "info", defaultRoles: ["business_owner", "admin", "contadora"], emailDefault: false },
  { type: "credit.due_3_days", module: "pagos", label: "Crédito vence en 3 días", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "contadora"], emailDefault: false },
  { type: "credit.due_1_day", module: "pagos", label: "Crédito vence mañana", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "contadora"], emailDefault: false },
  { type: "credit.due_today", module: "pagos", label: "Crédito vence hoy", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "contadora"], emailDefault: false },
  { type: "credit.overdue", module: "pagos", label: "Crédito comercial vencido", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin", "contadora"], emailDefault: false },
  { type: "commercial_credit.payment_registered", module: "pagos", label: "Abono de crédito registrado", defaultSeverity: "info", defaultRoles: ["technical_owner", "business_owner", "admin"], emailDefault: false },
  { type: "commercial_credit.paid_complete", module: "pagos", label: "Crédito comercial pagado completamente", defaultSeverity: "info", defaultRoles: ["technical_owner", "business_owner", "admin"], emailDefault: false },
  { type: "reservation.expired_review_required", module: "reservas", label: "Reserva vencida", defaultSeverity: "warning", defaultRoles: ["technical_owner", "business_owner", "admin", "bodega"], emailDefault: false },
  { type: "reservation.expiring_soon", module: "reservas", label: "Reserva por vencer", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: false },
  { type: "reservation.extended", module: "reservas", label: "Reserva extendida", defaultSeverity: "info", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: false },
  { type: "reservation.released", module: "reservas", label: "Reserva liberada", defaultSeverity: "info", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: false },
  { type: "order.ready_to_prepare", module: "pedidos", label: "Pedido listo para preparar", defaultSeverity: "info", defaultRoles: ["bodega"], emailDefault: false },
  { type: "order.logistics_review", module: "pedidos", label: "Revisión logística requerida", defaultSeverity: "warning", defaultRoles: ["bodega", "admin"], emailDefault: false },
  { type: "crm.followup_overdue", module: "CRM", label: "Seguimiento vencido", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "vendedor", "soporte"], emailDefault: true },
  { type: "crm.general_contact", module: "CRM", label: "Nuevo contacto general", defaultSeverity: "info", defaultRoles: ["business_owner", "admin", "vendedor", "soporte"], emailDefault: true },
  { type: "crm.wholesale_request", module: "CRM", label: "Nueva solicitud mayorista", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "crm.task_pending", module: "CRM", label: "Tarea pendiente", defaultSeverity: "info", defaultRoles: ["business_owner", "admin", "vendedor", "soporte"], emailDefault: false },
  { type: "crm.task_overdue", module: "CRM", label: "Tarea vencida", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "vendedor", "soporte"], emailDefault: true },
  { type: "inventory.low_stock", module: "inventario", label: "Stock bajo", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: false },
  { type: "inventory.out_of_stock", module: "inventario", label: "Producto agotado", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: true },
  { type: "inventory.critical_low_stock", module: "inventario", label: "Existencias críticamente bajas", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin", "bodega"], emailDefault: true },
  { type: "inventory.missing_image", module: "inventario", label: "Producto sin imagen", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: false },
  { type: "inventory.product_disabled", module: "inventario", label: "Producto desactivado", defaultSeverity: "info", defaultRoles: ["business_owner", "admin"], emailDefault: false },
  { type: "wholesale.request_new", module: "mayoristas", label: "Solicitud nueva", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "wholesale.request_pending_24h", module: "mayoristas", label: "Solicitud pendiente más de 24h", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "wholesale.approved", module: "mayoristas", label: "Mayorista aprobado", defaultSeverity: "info", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "wholesale.rejected", module: "mayoristas", label: "Mayorista rechazado", defaultSeverity: "warning", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "wholesale.suspended", module: "mayoristas", label: "Mayorista suspendido", defaultSeverity: "critical", defaultRoles: ["business_owner", "admin"], emailDefault: true },
  { type: "invoice.created", module: "sistema", label: "Nueva factura fiscal generada", defaultSeverity: "info", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "invoice.cancelled", module: "sistema", label: "Factura fiscal anulada", defaultSeverity: "warning", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.cai_expiring", module: "sistema", label: "CAI próximo a vencer", defaultSeverity: "warning", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.cai_expired", module: "sistema", label: "CAI vencido", defaultSeverity: "critical", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.range_low", module: "sistema", label: "Rango fiscal próximo a agotarse", defaultSeverity: "warning", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.invoice_error", module: "sistema", label: "Error al generar factura fiscal", defaultSeverity: "critical", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.correlative_invalid", module: "sistema", label: "Correlativo fiscal bloqueado o inválido", defaultSeverity: "critical", defaultRoles: ["technical_owner", "business_owner", "contadora"], emailDefault: true },
  { type: "fiscal.report_ready", module: "sistema", label: "Reporte fiscal listo", defaultSeverity: "info", defaultRoles: ["business_owner", "contadora"], emailDefault: false },
  { type: "system.cron_failed", module: "sistema", label: "Cron fallido", defaultSeverity: "critical", defaultRoles: ["technical_owner"], emailDefault: true, technicalOnly: true },
  { type: "system.backup_failed", module: "sistema", label: "Fallo en la copia de seguridad", defaultSeverity: "critical", defaultRoles: ["technical_owner"], emailDefault: true, technicalOnly: true },
  { type: "system.email_failed", module: "sistema", label: "Fallo en el correo electrónico", defaultSeverity: "critical", defaultRoles: ["technical_owner"], emailDefault: true, technicalOnly: true },
  { type: "system.cloudinary_high_usage", module: "sistema", label: "Uso alto de Cloudinary", defaultSeverity: "warning", defaultRoles: ["technical_owner"], emailDefault: true, technicalOnly: true },
  { type: "system.critical_error", module: "sistema", label: "Error crítico", defaultSeverity: "critical", defaultRoles: ["technical_owner"], emailDefault: true, technicalOnly: true },
  { type: "customer.order_status_update", module: "pedidos", label: "Actualizaciones de pedido al cliente", defaultSeverity: "info", defaultRoles: [], emailDefault: true },
  { type: "customer.order_cancelled", module: "pedidos", label: "Cancelación de pedido al cliente", defaultSeverity: "warning", defaultRoles: [], emailDefault: true },
  { type: "pos.price_request.created", module: "pedidos", label: "Precio especial solicitado", defaultSeverity: "warning", defaultRoles: ["technical_owner", "business_owner", "admin"], emailDefault: true },
  { type: "pos.price_request.approved", module: "pedidos", label: "Precio especial aprobado", defaultSeverity: "info", defaultRoles: [], emailDefault: true },
  { type: "pos.price_request.rejected", module: "pedidos", label: "Precio especial rechazado", defaultSeverity: "warning", defaultRoles: [], emailDefault: true },
  { type: "pos.price_request.revoked", module: "pedidos", label: "Precio especial revocado", defaultSeverity: "warning", defaultRoles: [], emailDefault: true },
] satisfies NotificationCatalogItem[];

export function getCatalogItem(type: string) {
  return notificationCatalog.find((item) => item.type === type);
}
