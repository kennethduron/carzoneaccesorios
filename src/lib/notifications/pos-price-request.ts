import "server-only";

import { enqueueEmail } from "@/lib/notifications/email-queue";
import { createInternalNotification, getPreferenceDelivery } from "@/lib/notifications/notification-center";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type { PosPriceRequest } from "@/types/sales-commercial";

async function queueForUsers(type: string, subject: string, message: string, actionPath: string, userIds?: string[]) {
  const delivery = await getPreferenceDelivery({ type });
  if (!delivery.emailEnabled) return;
  const admin = getSupabaseAdminClient();
  let query = admin.from("users").select("id,email,full_name,username,roles!inner(name)").eq("active", true).not("email", "is", null);
  if (userIds?.length) query = query.in("id", userIds);
  else query = query.in("roles.name", delivery.destinationRoles);
  const { data } = await query;
  await Promise.all((data ?? []).map((user: { id: string; email: string | null; full_name: string | null; username: string | null }) =>
    user.email ? enqueueEmail({
      toEmail: user.email, toName: user.full_name ?? user.username,
      subject, templateKey: type, relatedModule: "pedidos",
      idempotencyKey: `${type}:${actionPath}:${user.id}`,
      payload: { title: subject, message, action_path: actionPath, action_label: "Abrir solicitud" },
    }) : Promise.resolve(null),
  ));
}

export async function notifyPriceRequestCreated(request: PosPriceRequest) {
  const type = "pos.price_request.created";
  const actionPath = `/admin/aprobaciones-precio?request=${encodeURIComponent(request.requestId)}`;
  const message = `${request.sellerName} solicitó autorización para ${request.productName}.`;
  await createInternalNotification({ type, title: "Precio especial por revisar", message,
    severity: "warning", productId: request.productId, dedupeKey: `${type}:${request.requestId}`,
    metadata: { request_id: request.requestId, action_path: actionPath } });
  await queueForUsers(type, "Precio especial por revisar", message, actionPath);
}

export async function notifyPriceRequestDecision(request: PosPriceRequest) {
  const type = `pos.price_request.${request.status}`;
  const title = request.status === "approved" ? "Precio especial aprobado" : request.status === "revoked" ? "Precio especial revocado" : "Precio especial rechazado";
  const actionPath = `/admin/pos?priceRequest=${encodeURIComponent(request.requestId)}`;
  const message = `${title}: ${request.productName}.`;
  await createInternalNotification({ type, title, message, userId: request.sellerId,
    severity: request.status === "approved" ? "info" : "warning", productId: request.productId,
    dedupeKey: `${type}:${request.requestId}`, metadata: { request_id: request.requestId, action_path: actionPath } });
  await queueForUsers(type, title, message, actionPath, [request.sellerId]);
}
