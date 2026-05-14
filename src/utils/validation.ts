export type ValidationResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      message: string;
    };

export function cleanText(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

export function optionalText(value: unknown) {
  const text = cleanText(value);
  return text ? text : null;
}

export function requireText(value: unknown, label: string, maxLength = 180) {
  const text = cleanText(value);

  if (!text) {
    return { ok: false as const, message: `${label} es obligatorio.` };
  }

  if (text.length > maxLength) {
    return { ok: false as const, message: `${label} no puede superar ${maxLength} caracteres.` };
  }

  return { ok: true as const, value: text };
}

export function nonNegativeNumber(value: unknown, label: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false as const, message: `${label} debe ser un número mayor o igual a 0.` };
  }

  return { ok: true as const, value: parsed };
}

export function positiveInteger(value: unknown, label: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false as const, message: `${label} debe ser mayor que 0.` };
  }

  return { ok: true as const, value: Math.floor(parsed) };
}

export function optionalDateTime(value: unknown) {
  const text = cleanText(value);

  if (!text) {
    return { ok: true as const, value: null };
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return { ok: false as const, message: "La fecha ingresada no es valida." };
  }

  return { ok: true as const, value: text };
}

export function uuidLike(value: unknown, label = "ID") {
  const text = cleanText(value);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(text)) {
    return { ok: false as const, message: `${label} no es válido.` };
  }

  return { ok: true as const, value: text };
}

export function normalizeHondurasPhone(value: unknown) {
  const raw = cleanText(value);
  const normalized = raw.replace(/[\s\-()]/g, "");
  const digits = normalized.startsWith("+504")
    ? normalized.slice(4)
      : normalized.startsWith("504")
        ? normalized.slice(3)
        : normalized;

  return `+504${digits}`;
}

export function validateHondurasPhone(value: unknown) {
  const normalized = normalizeHondurasPhone(value);
  const digits = normalized.slice(4);
  const valid = /^[2389]\d{7}$/.test(digits) && digits !== "00000000";

  if (!valid) {
    return { ok: false as const, message: "Ingresa un número de teléfono válido de Honduras." };
  }

  return { ok: true as const, value: normalized };
}

export const hondurasPhone = validateHondurasPhone;

