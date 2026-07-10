import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import type { ImportTemplateDefinition } from "@/types/import-foundation";
import { buildImportTemplateResponse } from "@/utils/import-excel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const foundationTemplate: ImportTemplateDefinition = {
  title: "Plantilla base de importacion historica",
  description: "Formato compartido para validar staging, asignaciones y auditoria antes de conectar importadores especificos.",
  sheetName: "Importacion",
  columns: [
    { key: "documento", label: "Documento", required: true, example: "FAC-0001", width: 20 },
    { key: "nombre", label: "Nombre", required: true, example: "Cliente o proveedor", width: 28 },
    { key: "email", label: "Correo", example: "contacto@ejemplo.com", width: 28 },
    { key: "telefono", label: "Telefono", example: "9999-9999", width: 18 },
    { key: "rtn", label: "RTN", example: "08019999999999", width: 20 },
    { key: "codigo_futuro", label: "Codigo futuro", example: "CZ-0001", width: 18 },
    { key: "estado_importacion", label: "Estado importacion", dropdownOptions: ["Pendiente", "Validado", "Pendiente de asignacion"], readOnly: true, width: 24 },
    { key: "mensajes", label: "Mensajes de validacion", readOnly: true, width: 42 },
  ],
  examples: [
    {
      documento: "FAC-0001",
      nombre: "Cliente o proveedor de ejemplo",
      email: "contacto@ejemplo.com",
      telefono: "9999-9999",
      rtn: "08019999999999",
      codigo_futuro: "",
      estado_importacion: "Pendiente",
      mensajes: "",
    },
  ],
  instructions: [
    "Esta plantilla es solo la base compartida. No corresponde todavia a Cuentas por Cobrar ni Cuentas por Pagar.",
    "Los UUID internos no deben colocarse ni mostrarse en Excel.",
    "Los codigos futuros pueden venir importados, pero esta fase no genera codigos automaticamente.",
    "Las filas se cargaran a staging antes de cualquier aplicacion operativa futura.",
    "No se generan eventos financieros, partidas contables ni cambios en clientes o proveedores.",
  ],
};

export async function GET() {
  const profile = await requirePermission("admin:access");
  const allowed =
    hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);

  if (!allowed) {
    await requirePermission("technical:tools");
  }

  return buildImportTemplateResponse(foundationTemplate, "car-zone-plantilla-base-importacion.xlsx");
}
