import { commercialReportTypes, type CommercialFilters, type CommercialReportFormat, type CommercialReportType } from "@/types/commercial-reporting";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CommercialValidationError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "CommercialValidationError"; }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function normalizeCommercialFilters(input: Record<string, unknown>): CommercialFilters {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const from = typeof input.from === "string" && datePattern.test(input.from) ? input.from : start;
  const to = typeof input.to === "string" && datePattern.test(input.to) ? input.to : defaultTo;
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime) throw new CommercialValidationError("El período no es válido.", "REPORT_PERIOD_INVALID");
  if ((toTime - fromTime) / 86_400_000 > 366) throw new CommercialValidationError("El período no puede superar 366 días.", "REPORT_PERIOD_TOO_LARGE");
  const sellerId = typeof input.sellerId === "string" && input.sellerId !== "" ? input.sellerId : null;
  if (sellerId && !uuidPattern.test(sellerId)) throw new CommercialValidationError("El vendedor no es válido.", "REPORT_SELLER_INVALID");
  return {
    from, to, sellerId,
    channel: enumValue(input.channel, ["all", "pos", "web"] as const, "all"),
    customerType: enumValue(input.customerType, ["all", "retail", "wholesale"] as const, "all"),
    paymentMethod: enumValue(input.paymentMethod, ["all", "cash", "card", "bank_transfer", "commercial_credit"] as const, "all"),
    saleStatus: enumValue(input.saleStatus, ["all", "valid", "cancelled"] as const, "all"),
    specialPrice: enumValue(input.specialPrice, ["all", "with", "without"] as const, "all"),
    comparePrevious: input.comparePrevious === true || input.comparePrevious === "true",
  };
}

export function parseReportType(value: unknown): CommercialReportType {
  if (typeof value !== "string" || !commercialReportTypes.includes(value as CommercialReportType)) throw new CommercialValidationError("El tipo de reporte no es válido.", "REPORT_TYPE_INVALID");
  return value as CommercialReportType;
}

export function parseReportFormat(value: unknown): CommercialReportFormat {
  if (value !== "PDF" && value !== "XLSX") throw new CommercialValidationError("El formato debe ser PDF o Excel.", "REPORT_FORMAT_INVALID");
  return value;
}

export function parseReason(value: unknown, label = "motivo") {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (normalized.length < 10 || normalized.length > 500) throw new CommercialValidationError(`El ${label} debe tener entre 10 y 500 caracteres.`, "REPORT_REASON_INVALID");
  return normalized;
}

export function parseUuid(value: unknown, code = "ID_INVALID") {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new CommercialValidationError("El identificador no es válido.", code);
  return value;
}

export function parseBoundedStrings(value: unknown, allowed: readonly string[], fallback: readonly string[], max = 20) {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.includes(item)))];
  if (normalized.length > max) throw new CommercialValidationError("La selección supera el límite permitido.", "REPORT_SELECTION_TOO_LARGE");
  return normalized.length ? normalized : [...fallback];
}
