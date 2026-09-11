import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { getAdminPriceViewActor } from "@/lib/auth/admin-price-view";
import {
  adminPriceViewCookieName,
  isAdminPriceViewMode,
  normalizeAdminPriceViewProductIds,
} from "@/lib/admin-price-view";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminPriceViewInitialState, AdminWholesalePricesByProductId } from "@/types/admin-price-view";

type AdminPriceRow = {
  id: string;
  retail_price: number | string | null;
  wholesale_price: number | string | null;
};

export const getAdminPriceViewState = cache(async (): Promise<AdminPriceViewInitialState> => {
  const actor = await getAdminPriceViewActor();
  if (!actor.eligible || !actor.userId) {
    return { eligible: false, userId: null, mode: "retail" };
  }

  const cookieStore = await cookies();
  const storedMode = cookieStore.get(adminPriceViewCookieName(actor.userId))?.value;

  return {
    eligible: true,
    userId: actor.userId,
    mode: isAdminPriceViewMode(storedMode) ? storedMode : "retail",
  };
});

export async function getAdminWholesalePricesByProductId(
  productIds: readonly string[],
): Promise<AdminWholesalePricesByProductId> {
  const ids = normalizeAdminPriceViewProductIds(productIds);
  if (ids.length === 0) {
    return {};
  }

  const actor = await getAdminPriceViewActor();
  if (!actor.eligible) {
    return {};
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, retail_price, wholesale_price")
    .in("id", ids)
    .eq("active", true)
    .eq("status", "active")
    .returns<AdminPriceRow[]>();

  if (error) {
    console.error("Unable to load the administrative price view.", { code: error.code });
    return {};
  }

  return (data ?? []).reduce<AdminWholesalePricesByProductId>((prices, row) => {
    const retailPrice = Number(row.retail_price);
    const wholesalePrice = Number(row.wholesale_price);
    prices[row.id] = {
      wholesalePrice:
        Number.isFinite(wholesalePrice) && wholesalePrice > 0 && wholesalePrice <= retailPrice ? wholesalePrice : null,
    };
    return prices;
  }, {});
}
