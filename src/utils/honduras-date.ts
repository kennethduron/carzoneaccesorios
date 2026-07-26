const hondurasTimeZone = "America/Tegucigalpa";
const sqlDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isSqlDate(value: string): boolean {
  const match = sqlDatePattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.getUTCFullYear() === year && utcDate.getUTCMonth() === month - 1 && utcDate.getUTCDate() === day;
}

export function todayInHonduras(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: hondurasTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatSqlDateHn(value: string | null | undefined): string {
  if (!value || !isSqlDate(value)) return "-";
  const [, year, month, day] = sqlDatePattern.exec(value) ?? [];
  return `${day}/${month}/${year}`;
}

export function dateOnlyInHonduras(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isSqlDate(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  return todayInHonduras(instant);
}

export function invoiceCommercialDate(
  invoiceDate: string | null | undefined,
  issuedAt: string | null | undefined,
  createdAt: string | null | undefined,
): string | null {
  return (invoiceDate && isSqlDate(invoiceDate) ? invoiceDate : null)
    ?? dateOnlyInHonduras(issuedAt)
    ?? dateOnlyInHonduras(createdAt);
}
