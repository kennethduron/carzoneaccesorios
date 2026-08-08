import { z } from "zod";

const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable();
const optionalCharge = z.number().finite().min(0).max(999_999_999_999.99)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8, 'Los cargos deben tener máximo dos decimales.');
const chargeDescription = z.string().trim().max(120)
  .refine((value) => !/[<>\r\n\t]/.test(value), "La descripción no puede incluir HTML ni saltos de línea.")
  .nullable();

export const createPosDraftSchema = z.object({
  requestKey: z.string().uuid(),
  customerId: z.string().uuid(),
}).strict();

export const savePosDraftSchema = z.object({
  requestKey: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  customerId: z.string().uuid(),
  expectedCustomerCommercialVersion: z.number().int().nonnegative(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(9999),
    finalUnitPrice: z.number().finite().positive().nullable(),
    priceOverrideReason: nullableText(500),
    expectedProductSalesVersion: z.number().int().positive(),
  }).strict()).max(200),
  deliveryMode: z.enum(["store_immediate", "home_delivery", "cash_on_delivery"]),
  deliveryAddress: nullableText(500),
  deliveryNotes: nullableText(1000),
  internalNotes: nullableText(1000),
  shippingFee: optionalCharge,
  codFee: optionalCharge,
  additionalCharge: optionalCharge,
  additionalChargeDescription: chargeDescription,
  otherCharge: optionalCharge,
  otherChargeDescription: chargeDescription,
}).strict().superRefine((value, context) => {
  if (value.additionalCharge > 0 && (value.additionalChargeDescription?.trim().length ?? 0) < 2) {
    context.addIssue({ code: "custom", path: ["additionalChargeDescription"], message: "Describe el cargo adicional con al menos 2 caracteres." });
  }
  if (value.otherCharge > 0 && (value.otherChargeDescription?.trim().length ?? 0) < 2) {
    context.addIssue({ code: "custom", path: ["otherChargeDescription"], message: "Describe el otro cargo con al menos 2 caracteres." });
  }
});

export const abandonPosDraftSchema = z.object({
  requestKey: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

const invoiceDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const confirmationPaymentSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("cash"),
    amountTendered: z.number().finite().nonnegative().max(999_999_999_999.99),
  }).strict(),
  z.object({
    method: z.literal("bank_transfer"),
    verified: z.literal(true),
    reference: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    method: z.literal("card"),
    verified: z.literal(true),
    reference: z.string().trim().max(200).nullable(),
  }).strict(),
  z.object({ method: z.literal("commercial_credit") }).strict(),
]);

export const confirmPosSaleSchema = z.object({
  requestKey: z.string().uuid(),
  expectedDraftVersion: z.number().int().positive(),
  invoiceDate: invoiceDateSchema,
  payment: confirmationPaymentSchema,
}).strict();

export const posProductSearchSchema = z.object({
  query: z.string().trim().max(120).transform((value) => value.replace(/\s+/g, " ")),
  customerId: z.string().uuid(),
  expectedCustomerCommercialVersion: z.coerce.number().int().nonnegative(),
  categoryId: z.string().uuid().nullable().optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  includeUnavailable: z.enum(["true", "false"]).transform((value) => value === "true").default(true),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
}).strict();

export function firstZodMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "La solicitud contiene datos invalidos.";
}
