import type { NextRequest } from "next/server";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { getCustomerInvoiceDetail } from "@/services/supabase/customer-account.service";
import { buildInvoicePdfResponse } from "@/utils/invoice-pdf-response";
import { storeInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ invoiceId: string }> }) {
  const profile = await getSessionProfile();

  if (!profile) {
    return Response.json({ message: "No autenticado." }, { status: 401 });
  }

  if (!hasEffectivePermission(profile.role, profile.permissions, "invoices:read_own", profile.email)) {
    return Response.json({ message: "Sin permiso para consultar facturas de cliente." }, { status: 403 });
  }

  const { invoiceId } = await params;
  const invoice = await getCustomerInvoiceDetail(profile.id, invoiceId);

  if (!invoice) {
    return Response.json({ message: "Factura no encontrada." }, { status: 404 });
  }

  const disposition = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return buildInvoicePdfResponse(storeInvoiceToOfficialInvoice(invoice), disposition);
}
