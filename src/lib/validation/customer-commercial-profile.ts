import { z } from "zod";

const forbiddenCommercialTextPattern = /[<>\u0000-\u001f\u007f]/u;

export function normalizeOptionalCommercialText(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function normalizeCustomerRtn(value: unknown) {
  const normalized = normalizeOptionalCommercialText(value);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

export function optionalCommercialTextSchema(maximum: number, tooLongMessage: string) {
  return z.preprocess(
    normalizeOptionalCommercialText,
    z
      .string()
      .max(maximum, tooLongMessage)
      .refine(
        (value) => !forbiddenCommercialTextPattern.test(value),
        "Este dato contiene caracteres no permitidos.",
      )
      .nullable(),
  );
}

export const optionalCustomerRtnSchema = z.preprocess(
  normalizeOptionalCommercialText,
  z
    .string()
    .max(40, "El RTN es demasiado largo.")
    .refine(
      (value) => /^[0-9 -]+$/.test(value) && normalizeCustomerRtn(value) !== null,
      "El RTN debe contener 14 dígitos.",
    )
    .transform((value) => normalizeCustomerRtn(value) as string)
    .nullable(),
);

export const customerCommercialProfileSchema = z.object({
  businessName: optionalCommercialTextSchema(160, "El nombre del negocio es demasiado largo."),
  taxId: optionalCustomerRtnSchema,
  city: optionalCommercialTextSchema(120, "La ubicación es demasiado larga."),
});
