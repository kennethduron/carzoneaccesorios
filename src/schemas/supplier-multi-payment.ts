import { z } from "zod";

const moneySchema = z
  .number()
  .finite()
  .positive("El importe debe ser mayor que cero.")
  .max(9_999_999_999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    "El importe admite como máximo dos decimales.",
  );

export const supplierPaymentMethodSchema = z.enum([
  "cash",
  "bank_transfer",
  "card_credit",
  "card_debit",
]);

export const supplierPaymentApplicationSchema = z
  .object({
    accounts_payable_id: z.uuid(),
    applied_amount: moneySchema,
  })
  .strict();

export const supplierMultiPaymentSchema = z
  .object({
    request_key: z.uuid(),
    supplier_id: z.uuid(),
    payment_method: supplierPaymentMethodSchema,
    paid_date: z.iso.date(),
    reference: z.string().trim().max(160).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    receipt_public_id: z.string().trim().max(240).nullable().optional(),
    applications: z
      .array(supplierPaymentApplicationSchema)
      .min(1, "Selecciona por lo menos una cuenta por pagar.")
      .max(200, "Un pago admite como máximo 200 aplicaciones."),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, application] of value.applications.entries()) {
      if (ids.has(application.accounts_payable_id)) {
        context.addIssue({
          code: "custom",
          path: ["applications", index, "accounts_payable_id"],
          message: "Una cuenta por pagar no puede aparecer dos veces.",
        });
      }
      ids.add(application.accounts_payable_id);
    }

    if (
      value.payment_method === "bank_transfer" &&
      !value.reference?.trim()
    ) {
      context.addIssue({
        code: "custom",
        path: ["reference"],
        message: "La referencia es obligatoria para una transferencia bancaria.",
      });
    }
  });

export const supplierOpenPayablesQuerySchema = z
  .object({
    supplier_id: z.uuid(),
    effective_payment_date: z.iso.date(),
    accounts_payable_id: z.uuid().optional(),
    accounts_payable_ids: z.array(z.uuid()).min(1).max(200).optional(),
    query: z.string().trim().max(120).optional().default(""),
    cursor_due_date: z.iso.date().nullable().optional(),
    cursor_id: z.uuid().nullable().optional(),
    page_size: z.number().int().min(1).max(200).optional().default(30),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.accounts_payable_id && value.accounts_payable_ids) {
      context.addIssue({
        code: "custom",
        path: ["accounts_payable_ids"],
        message: "Usa un solo modo de selección de cuentas por pagar.",
      });
    }
  });

export const supplierMultiPaymentVoidSchema = z
  .object({
    payment_id: z.uuid(),
    request_key: z.uuid(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export type SupplierMultiPaymentInput = z.infer<
  typeof supplierMultiPaymentSchema
>;
export type SupplierMultiPaymentVoidInput = z.infer<
  typeof supplierMultiPaymentVoidSchema
>;
export type SupplierOpenPayablesQuery = z.infer<
  typeof supplierOpenPayablesQuerySchema
>;

export type SupplierMultiPaymentRpcResult = {
  status: "paid" | "voided";
  replayed: boolean;
  payment_id: string;
  supplier_id: string;
  payment_total: number;
  application_count: number;
  applications: Array<{
    application_id: string;
    accounts_payable_id: string;
    applied_amount: number;
    balance_before: number;
    balance_after: number;
    status_after: string;
  }>;
  outbox_id: string;
  accounting_status: string;
  accounting_date: string;
};
