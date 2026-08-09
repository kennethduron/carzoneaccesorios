import { z } from "zod";
import type { PosCustomerUpdateInput, PosCustomerWriteInput } from "@/types/point-of-sale";
import { optionalCustomerRtnSchema } from "@/lib/validation/customer-commercial-profile";

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
    z.string().max(maximum).nullable(),
  );

const phone = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
  z.string()
    .max(40)
    .refine((value) => /^[+()0-9 .-]+$/.test(value), "CUSTOMER_PHONE_INVALID")
    .refine((value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 20;
    }, "CUSTOMER_PHONE_INVALID")
    .nullable(),
);

const email = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null),
  z.string().email("CUSTOMER_EMAIL_INVALID").max(254).nullable(),
);

const taxId = optionalCustomerRtnSchema;

const schema = z.object({
  requestKey: z.string().uuid(),
  contactName: z.string().trim().min(1, "CUSTOMER_NAME_REQUIRED").max(160),
  phone,
  email,
  businessName: optionalText(160),
  taxId,
  address: optionalText(500),
  city: optionalText(120),
  commercialNotes: optionalText(1000),
  customerType: z.enum(["retail", "wholesale"]),
  creditMode: z.enum(["none", "unchanged", "active", "suspended", "disabled"]),
  creditLimit: z.coerce.number().finite().min(0).max(9_999_999_999.99),
  creditTermsDays: z.coerce.number().int().min(1).max(365),
  creditNotes: optionalText(1000),
  changeReason: z.string().trim().min(5).max(500),
  duplicateOverrideReason: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
    z.string().min(5).max(500).nullable(),
  ),
  expectedCommercialVersion: z.coerce.number().int().min(0).optional(),
}).superRefine((value, context) => {
  if ((value.creditMode === "active" || value.creditMode === "suspended") && value.creditLimit <= 0) {
    context.addIssue({ code: "custom", message: "CREDIT_CONFIGURATION_INVALID", path: ["creditLimit"] });
  }
});

const safeMessages: Record<string, string> = {
  CUSTOMER_NAME_REQUIRED: "El nombre o razón social es obligatorio.",
  CUSTOMER_PHONE_INVALID: "El teléfono debe contener entre 8 y 20 dígitos.",
  CUSTOMER_EMAIL_INVALID: "El correo electrónico no tiene un formato válido.",
  CUSTOMER_RTN_INVALID: "El RTN debe contener 14 dígitos.",
  CREDIT_CONFIGURATION_INVALID: "Revisa el límite, plazo y estado del crédito comercial.",
};

export type PosCustomerParseResult<T extends PosCustomerWriteInput = PosCustomerWriteInput> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function parsePosCustomerInput(
  body: unknown,
  options: { mode: "create" },
): PosCustomerParseResult<PosCustomerWriteInput>;
export function parsePosCustomerInput(
  body: unknown,
  options: { customerId: string; mode: "update" },
): PosCustomerParseResult<PosCustomerUpdateInput>;
export function parsePosCustomerInput(
  body: unknown,
  options: { customerId?: string; mode: "create" | "update" },
): PosCustomerParseResult<PosCustomerWriteInput | PosCustomerUpdateInput> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: safeMessages[issue?.message ?? ""] ?? "La configuración comercial contiene datos inválidos." };
  }
  if (options.mode === "create" && !["none", "active"].includes(parsed.data.creditMode)) {
    return { ok: false, message: safeMessages.CREDIT_CONFIGURATION_INVALID };
  }
  if (options.mode === "update" && (!options.customerId || parsed.data.expectedCommercialVersion === undefined)) {
    return { ok: false, message: "La versión comercial del cliente es obligatoria." };
  }

  const base: PosCustomerWriteInput = {
    requestKey: parsed.data.requestKey,
    contactName: parsed.data.contactName,
    phone: parsed.data.phone,
    email: parsed.data.email,
    businessName: parsed.data.businessName,
    taxId: parsed.data.taxId,
    address: parsed.data.address,
    city: parsed.data.city,
    commercialNotes: parsed.data.commercialNotes,
    customerType: parsed.data.customerType,
    creditMode: parsed.data.creditMode,
    creditLimit: parsed.data.creditLimit,
    creditTermsDays: parsed.data.creditTermsDays,
    creditNotes: parsed.data.creditNotes,
    changeReason: parsed.data.changeReason,
    duplicateOverrideReason: parsed.data.duplicateOverrideReason,
  };
  if (options.mode === "create") return { ok: true, value: base };
  return {
    ok: true,
    value: {
      ...base,
      customerId: options.customerId!,
      expectedCommercialVersion: parsed.data.expectedCommercialVersion!,
    },
  };
}
