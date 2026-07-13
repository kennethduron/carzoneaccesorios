import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { wouldCreateAccountCycle } from "@/services/accounting/account-hierarchy";
import type { AccountingAccountHierarchyOption } from "@/types/accounting";

const hierarchyPageSize = 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParentValidationResult =
  | { ok: true; parentId: string | null }
  | { ok: false; message: string };

export async function getAccountingAccountHierarchyOptions(): Promise<AccountingAccountHierarchyOption[]> {
  const supabase = await getSupabaseServerClient();
  const options: AccountingAccountHierarchyOption[] = [];

  for (let from = 0; ; from += hierarchyPageSize) {
    const { data, error } = await supabase
      .from("accounting_accounts")
      .select("id, code, name, parent_id, is_active")
      .order("code", { ascending: true })
      .range(from, from + hierarchyPageSize - 1)
      .returns<AccountingAccountHierarchyOption[]>();

    if (error) throw new Error("No se pudo cargar la jerarquía del catálogo de cuentas.");
    options.push(...(data ?? []));
    if (!data || data.length < hierarchyPageSize) break;
  }

  return options;
}

export async function validateAccountingAccountParent(input: {
  accountId?: string | null;
  parentId?: string | null;
}): Promise<ParentValidationResult> {
  const parentId = input.parentId?.trim() || null;
  if (!parentId) return { ok: true, parentId: null };

  if (!uuidPattern.test(parentId)) {
    return { ok: false, message: "Selecciona una cuenta padre v\u00e1lida." };
  }

  if (input.accountId && parentId === input.accountId) {
    return { ok: false, message: "Una cuenta no puede ser su propia cuenta padre." };
  }

  return validateExistingParent(input.accountId, parentId);
}

async function validateExistingParent(accountId: string | null | undefined, parentId: string): Promise<ParentValidationResult> {
  const supabase = await getSupabaseServerClient();
  const { data: parent, error: parentError } = await supabase
    .from("accounting_accounts")
    .select("id, is_active")
    .eq("id", parentId)
    .maybeSingle<{ id: string; is_active: boolean }>();

  if (parentError) {
    return { ok: false, message: "No se pudo validar la cuenta padre seleccionada." };
  }

  if (!parent) {
    return { ok: false, message: "La cuenta padre seleccionada no existe." };
  }

  if (!parent.is_active) {
    return { ok: false, message: "La cuenta padre seleccionada est\u00e1 inactiva." };
  }

  if (accountId) {
    try {
      const hierarchy = await getAccountingAccountHierarchyOptions();
      if (wouldCreateAccountCycle(hierarchy, accountId, parentId)) {
        return { ok: false, message: "La cuenta padre seleccionada es descendiente de esta cuenta." };
      }
    } catch {
      return { ok: false, message: "No se pudo validar la jerarqu\u00eda de la cuenta seleccionada." };
    }
  }

  return { ok: true, parentId };
}

export function getAccountingAccountSaveErrorMessage(
  error: { code?: string | null },
  options: { hasParent: boolean },
) {
  if (error.code === "23505") return "Ya existe una cuenta contable con ese c\u00f3digo.";
  if (error.code === "23503" && options.hasParent) return "La cuenta padre seleccionada ya no existe.";
  if (error.code === "22P02") return "Los datos de la cuenta contable no son v\u00e1lidos.";
  if (error.code === "23514") return "La cuenta contable no cumple las validaciones requeridas.";
  return "No se pudo guardar la cuenta contable.";
}
