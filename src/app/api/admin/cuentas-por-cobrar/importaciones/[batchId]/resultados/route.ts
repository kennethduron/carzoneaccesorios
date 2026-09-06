import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getHistoricalReceivableImportExportRows } from "@/services/supabase/accounts-receivable-import.service";
import { buildUtf8BomCsv } from "@/utils/spreadsheet-safety";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const profile = await requirePermission("admin:access");
  const allowed = hasEffectivePermission(profile.role, profile.permissions, "receivables:import", profile.email)
    || hasEffectivePermission(profile.role, profile.permissions, "receivables:review", profile.email);
  if (!allowed) return Response.json({ error: "No tienes permiso para exportar resultados de importación." }, { status: 403 });
  const { batchId } = await params;
  const rows = await getHistoricalReceivableImportExportRows(batchId);
  const csv = buildUtf8BomCsv([
    ["Fila", "Cliente", "Factura / referencia", "Importe original", "Abonado", "Saldo", "Validación", "Asignación", "Aplicación", "Mensajes"],
    ...rows.map((row) => [
      row.row_number,
      String(row.normalized_data.customer_name ?? ""),
      String(row.normalized_data.invoice_number ?? ""),
      Number(row.normalized_data.original_amount ?? 0),
      Number(row.normalized_data.paid_amount ?? 0),
      Number(row.normalized_data.balance_due ?? 0),
      row.validation_status,
      row.assignment_status,
      row.apply_status,
      [...row.validation_messages, row.apply_error].filter(Boolean).join(" | "),
    ]),
  ]);
  return new Response(csv, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="car-zone-importacion-cxc-${batchId.slice(0, 8)}.csv"`,
    "Cache-Control": "private, no-store",
  }});
}
