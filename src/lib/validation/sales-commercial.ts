import { z } from "zod";

export const createPriceRequestSchema = z.object({
  requestKey: z.uuid(),
  draftId: z.uuid(),
  expectedDraftVersion: z.number().int().nonnegative(),
  itemId: z.uuid(),
  requestedUnitPrice: z.number().positive().max(999_999_999.99),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const decidePriceRequestSchema = z.object({
  action: z.enum(["approve", "reject", "revoke", "cancel"]),
  reason: z.string().trim().max(500).nullable().optional(),
}).strict();

export const correctPosSellerSchema = z.object({
  sellerUserId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
}).strict();

export const priceRequestListSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled", "consumed", "revoked", "expired"]).optional(),
  q: z.string().trim().max(120).optional(),
  seller: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const mySalesListSchema = z.object({
  from: z.iso.date(), to: z.iso.date(),
  status: z.string().trim().max(30).optional(),
  method: z.enum(["cash", "card", "bank_transfer", "commercial_credit"]).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
