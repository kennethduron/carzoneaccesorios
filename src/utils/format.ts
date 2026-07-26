import { formatSqlDateHn, isSqlDate } from "@/utils/honduras-date";

const hondurasTimeZone = "America/Tegucigalpa";
const monthNames = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const dateTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: hondurasTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function getDateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = Object.fromEntries(dateTimePartsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    day: parts.day ?? "00",
    month: parts.month ?? "00",
    year: parts.year ?? "0000",
    hour: parts.hour === "24" ? "00" : parts.hour ?? "00",
    minute: parts.minute ?? "00",
    second: parts.second ?? "00",
  };
}

export function formatHnDate(value: string | null) {
  if (!value) {
    return "-";
  }

  if (isSqlDate(value)) {
    return formatSqlDateHn(value).replace(/^0/, "").replace("/0", "/");
  }

  const parts = getDateParts(value);
  return parts ? `${Number(parts.day)}/${Number(parts.month)}/${parts.year}` : "-";
}

export function formatHnDateTime(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("es-HN", {
    timeZone: hondurasTimeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function formatHnMonth(value: string) {
  const parts = getDateParts(value);
  if (!parts) {
    return "-";
  }

  const monthIndex = Math.max(0, Math.min(11, Number(parts.month) - 1));
  return `${monthNames[monthIndex]} de ${parts.year}`;
}
