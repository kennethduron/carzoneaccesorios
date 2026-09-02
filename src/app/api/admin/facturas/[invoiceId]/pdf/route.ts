import type { NextRequest } from "next/server";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";
import { buildInvoicePdfResponse } from "@/utils/invoice-pdf-response";
import { adminInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ invoiceId: string }> }) {
  const profile = await getSessionProfile();

  if (!profile) {
    return Response.json({ message: "No autenticado." }, { status: 401 });
  }

  if (!hasEffectivePermission(profile.role, profile.permissions, "invoices:read", profile.email)
    && !hasEffectivePermission(profile.role, profile.permissions, "pos:sales:read_own", profile.email)) {
    return Response.json({ message: "Sin permiso para consultar facturas administrativas." }, { status: 403 });
  }

  const { invoiceId } = await params;
  const invoice = await getAdminInvoiceDetail(invoiceId, {
    includeFiscalCorrectionHistory: hasEffectivePermission(profile.role, profile.permissions, "invoices:read", profile.email),
  });

  if (!invoice) {
    return Response.json({ message: "Factura no encontrada." }, { status: 404 });
  }

  const disposition = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return buildInvoicePdfResponse(adminInvoiceToOfficialInvoice(invoice), disposition);
}
