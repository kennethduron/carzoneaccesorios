import { z } from "zod";
import { commissionRuleTypes, commissionStatuses } from "@/types/commissions";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

export const commissionListSchema = z.object({
  sellerId: z.union([uuid, z.literal("")]).optional(),
  status: z.union([z.enum(commissionStatuses), z.literal("")]).optional(),
  ruleType: z.union([z.enum(commissionRuleTypes), z.literal("")]).optional(),
  from: isoDate.optional(), to: isoDate.optional(), q: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

export const ruleInputSchema = z.object({
  requestKey: uuid, sellerId: uuid, type: z.enum(commissionRuleTypes),
  value: z.coerce.number().positive().max(1000000), effectiveDate: isoDate,
  reason: z.string().trim().min(10).max(500), confirmation: z.literal(true),
}).superRefine((value, context) => {
  if (value.type === "PERCENTAGE" && value.value > 100) context.addIssue({ code: "custom", path: ["value"], message: "El porcentaje no puede exceder 100%." });
});

export const adjustmentInputSchema = z.object({
  requestKey: uuid, entryId: uuid, amountDelta: z.coerce.number().refine((value) => value !== 0),
  reason: z.string().trim().min(10).max(500),
});
