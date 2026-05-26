import { NextResponse, type NextRequest } from "next/server";
import { configureCloudinary } from "@/lib/cloudinary";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { writeAuditLog } from "@/lib/audit";

export const dynamic = "force-dynamic";

type PaymentReceiptRow = {
  id: string;
  order_id: string;
  transfer_receipt_url: string | null;
  transfer_receipt_public_id: string | null;
  transfer_receipt_resource_type: string | null;
  transfer_receipt_delivery_type: string | null;
  transfer_receipt_format: string | null;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  await requirePermission("payments:manage");
  const { paymentId } = await params;
  const admin = getSupabaseAdminClient();
  const { data: payment, error } = await admin
    .from("payments")
    .select(
      "id, order_id, transfer_receipt_url, transfer_receipt_public_id, transfer_receipt_resource_type, transfer_receipt_delivery_type, transfer_receipt_format",
    )
    .eq("id", paymentId)
    .maybeSingle<PaymentReceiptRow>();

  if (error || !payment) {
    return NextResponse.json({ message: "Comprobante no encontrado." }, { status: 404 });
  }

  await admin
    .from("payments")
    .update({ transfer_receipt_accessed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", payment.id);

  await writeAuditLog({
    tableName: "payments",
    recordId: payment.id,
    action: "payment.transfer_receipt.accessed",
    newData: {
      order_id: payment.order_id,
      private_receipt: Boolean(payment.transfer_receipt_public_id),
    },
  });

  if (payment.transfer_receipt_public_id) {
    const cloudinary = configureCloudinary();
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
    const signedUrl = cloudinary.utils.private_download_url(
      payment.transfer_receipt_public_id,
      payment.transfer_receipt_format || "jpg",
      {
        resource_type: payment.transfer_receipt_resource_type || "image",
        type: payment.transfer_receipt_delivery_type || "authenticated",
        expires_at: expiresAt,
        attachment: false,
      },
    );

    const response = NextResponse.redirect(signedUrl, { status: 302 });
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  if (payment.transfer_receipt_url) {
    const response = NextResponse.redirect(payment.transfer_receipt_url, { status: 302 });
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  return NextResponse.json({ message: "Este pago no tiene comprobante." }, { status: 404 });
}
