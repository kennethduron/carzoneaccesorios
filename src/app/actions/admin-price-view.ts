"use server";

import { cookies } from "next/headers";
import { getAdminPriceViewActor } from "@/lib/auth/admin-price-view";
import { adminPriceViewCookieName, isAdminPriceViewMode } from "@/lib/admin-price-view";
import type { AdminPriceViewMode } from "@/types/admin-price-view";

export type SetAdminPriceViewResult =
  | { ok: true; mode: AdminPriceViewMode }
  | { ok: false; error: string };

export async function setAdminPriceViewModeAction(mode: unknown): Promise<SetAdminPriceViewResult> {
  if (!isAdminPriceViewMode(mode)) {
    return { ok: false, error: "La vista solicitada no es válida." };
  }

  const actor = await getAdminPriceViewActor();
  if (!actor.eligible || !actor.userId) {
    return { ok: false, error: "Tu cuenta no tiene acceso a esta preferencia." };
  }

  const cookieStore = await cookies();
  cookieStore.set(adminPriceViewCookieName(actor.userId), mode, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
    priority: "medium",
  });

  return { ok: true, mode };
}
