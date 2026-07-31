"use server";

import { z } from "zod";
import { getPortalCommercialContextV2 } from "@/services/supabase/portal-commercial-context.service";
import { getProductsByIdsForPortal } from "@/services/supabase/products.service";
import type { Product } from "@/types/commerce";
import type { PortalCommercialContext } from "@/types/portal-commercial";

const productIdsSchema = z.array(z.uuid()).max(100);

export async function getPortalCommercialContextAction(): Promise<PortalCommercialContext> {
  return getPortalCommercialContextV2();
}

export async function getCartProductsAction(productIds: unknown): Promise<Product[]> {
  const parsed = productIdsSchema.safeParse(productIds);
  if (!parsed.success) return [];
  return getProductsByIdsForPortal(Array.from(new Set(parsed.data)));
}
