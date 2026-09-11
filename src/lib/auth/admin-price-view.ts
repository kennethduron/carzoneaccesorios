import "server-only";

import { cache } from "react";
import { getSessionProfile } from "@/lib/auth/session";
import { canUseAdminPriceView } from "@/lib/admin-price-view";
import type { AppRole } from "@/types/auth";

export type AdminPriceViewActor = {
  eligible: boolean;
  userId: string | null;
  role: AppRole | null;
};

export const getAdminPriceViewActor = cache(async (): Promise<AdminPriceViewActor> => {
  const profile = await getSessionProfile();

  if (!profile || !canUseAdminPriceView(profile.role)) {
    return { eligible: false, userId: null, role: profile?.role ?? null };
  }

  return { eligible: true, userId: profile.id, role: profile.role };
});
