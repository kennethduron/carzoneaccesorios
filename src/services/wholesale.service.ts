import type { WholesaleAccount } from "@/types/wholesale";
import { wholesaleAccounts } from "@/lib/commerce";

export function validateWholesaleCode(code: string): WholesaleAccount | null {
  const normalized = code.trim().toUpperCase();
  const account = wholesaleAccounts.find((item) => item.code === normalized);

  if (!account) {
    return null;
  }

  const today = new Date();
  const expiresAt = new Date(`${account.expiresAt}T23:59:59`);

  return expiresAt >= today ? account : null;
}
