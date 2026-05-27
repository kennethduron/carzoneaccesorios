"use server";

import { writeErrorLog } from "@/lib/error-logging";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export type PublicTrackingItem = {
  sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

const FINALIZED_TRACKING_MESSAGE =
  "Este pedido ya fue finalizado. Para más información, contacta a Car Zone Accesorios.";
const TRACKING_NOT_FOUND_MESSAGE = "Código de seguimiento no encontrado.";

export type PublicTrackingOrder = {
  orderNumber: string;
  trackingCode: string;
  trackingStatus: string;
  orderStatus: string;
  paymentStatus: string;
  hasTransferReceipt: boolean;
  hasBankReference: boolean;
  createdAt: string;
  paymentMethod: string;
  total: number;
  customerNameMasked: string;
  phoneLast4: string;
  items: PublicTrackingItem[];
};

type PublicTrackingRpcRow = {
  lookup_status?: "active" | "finalized";
  order_number: string | null;
  tracking_code: string | null;
  tracking_status: string | null;
  order_status: string | null;
  payment_status: string | null;
  has_transfer_receipt: boolean | null;
  has_bank_reference: boolean | null;
  created_at: string | null;
  payment_method: string | null;
  total: unknown;
  customer_name_masked: string | null;
  phone_last4: string | null;
  items: PublicTrackingItem[] | string | null;
};

export type PublicTrackingResult =
  | { ok: true; order: PublicTrackingOrder }
  | { ok: false; message: string };

export async function getPublicOrderTrackingAction(rawCode: string): Promise<PublicTrackingResult> {
  const trackingCode = rawCode.trim().toUpperCase();
  const trackingLimit = await checkRateLimit({
    route: "/rastreo",
    limit: 10,
    windowSeconds: 5 * 60,
    key: trackingCode.slice(-6),
  });

  if (!trackingLimit.ok) {
    return { ok: false, message: getRateLimitMessage(trackingLimit.retryAfter) };
  }

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
      return { ok: false, message: TRACKING_NOT_FOUND_MESSAGE };
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return { ok: false, message: TRACKING_NOT_FOUND_MESSAGE };
    }

    if (row.lookup_status === "finalized") {
      return { ok: false, message: FINALIZED_TRACKING_MESSAGE };
    }

    if (
      !row.order_number ||
      !row.tracking_code ||
      !row.tracking_status ||
      !row.order_status ||
      !row.payment_status ||
      !row.created_at ||
      !row.payment_method
    ) {
      return { ok: false, message: TRACKING_NOT_FOUND_MESSAGE };
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
        hasTransferReceipt: Boolean(row.has_transfer_receipt),
        hasBankReference: Boolean(row.has_bank_reference),
        createdAt: row.created_at,
        paymentMethod: row.payment_method,
        total: Number(row.total ?? 0),
        customerNameMasked: row.customer_name_masked ?? "",
        phoneLast4: row.phone_last4 ?? "",
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
    return { ok: false, message: TRACKING_NOT_FOUND_MESSAGE };
  }
}

