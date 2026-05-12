"use server";

import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export type PublicTrackingItem = {
  sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

export type PublicTrackingOrder = {
  orderNumber: string;
  trackingCode: string;
  trackingStatus: string;
  orderStatus: string;
  paymentStatus: string;
  createdAt: string;
  paymentMethod: string;
  total: number;
  customerNameMasked: string;
  phoneLast4: string;
  items: PublicTrackingItem[];
};

type PublicTrackingRpcRow = {
  order_number: string;
  tracking_code: string;
  tracking_status: string;
  order_status: string;
  payment_status: string;
  created_at: string;
  payment_method: string;
  total: unknown;
  customer_name_masked: string;
  phone_last4: string;
  items: PublicTrackingItem[] | string | null;
};

export type PublicTrackingResult =
  | { ok: true; order: PublicTrackingOrder }
  | { ok: false; message: string };

export async function getPublicOrderTrackingAction(rawCode: string): Promise<PublicTrackingResult> {
  const trackingCode = rawCode.trim().toUpperCase();

  if (!trackingCode) {
    return { ok: false, message: "Ingresa el código de seguimiento." };
  }

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .rpc("get_public_order_tracking", { raw_tracking_code: trackingCode })
      .returns<PublicTrackingRpcRow[]>();

    if (error) {
      await writeErrorLog({
        route: "/rastreo",
        action: "tracking.lookup_failed",
        errorMessage: error.message,
        metadata: {
          code_suffix: trackingCode.slice(-4),
        },
      });
      return { ok: false, message: "No encontramos un pedido con ese código. Verifica e intenta nuevamente." };
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return { ok: false, message: "No encontramos un pedido con ese código. Verifica e intenta nuevamente." };
    }

    const items = Array.isArray(row.items)
      ? row.items
      : typeof row.items === "string"
        ? (JSON.parse(row.items) as PublicTrackingItem[])
        : [];

    return {
      ok: true,
      order: {
        orderNumber: row.order_number,
        trackingCode: row.tracking_code,
        trackingStatus: row.tracking_status,
        orderStatus: row.order_status,
        paymentStatus: row.payment_status,
        createdAt: row.created_at,
        paymentMethod: row.payment_method,
        total: Number(row.total ?? 0),
        customerNameMasked: row.customer_name_masked,
        phoneLast4: row.phone_last4,
        items,
      },
    };
  } catch (error) {
    await writeErrorLog({
      route: "/rastreo",
      action: "tracking.lookup_unhandled",
      errorMessage: error instanceof Error ? error.message : "Unknown tracking lookup error",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        code_suffix: trackingCode.slice(-4),
      },
    });
    return { ok: false, message: "No encontramos un pedido con ese código. Verifica e intenta nuevamente." };
  }
}
