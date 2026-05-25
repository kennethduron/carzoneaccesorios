import type { User } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { normalizeAuthEmail } from "@/lib/auth/profile-sync";

export function isValidAuthEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getAuthUserByEmail(emailInput: string): Promise<User | null> {
  const email = normalizeAuthEmail(emailInput);
  if (!isValidAuthEmail(email)) {
    return null;
  }

  const admin = getSupabaseAdminClient();

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) {
      throw error;
    }

    const match = (data.users ?? []).find((user) => user.email?.toLowerCase() === email);
    if (match) {
      return match;
    }

    if ((data.users ?? []).length < 100) {
      break;
    }
  }

  return null;
}

export async function isAuthEmailConfirmed(emailInput: string) {
  const user = await getAuthUserByEmail(emailInput);
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}
