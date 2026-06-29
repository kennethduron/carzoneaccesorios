import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingMappingType } from "@/types/financial-center";

export type MappingRequirement = {
  mappingType: AccountingMappingType;
  sourceKey: string;
  label: string;
};

export type ResolvedAccountingAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  is_active: boolean;
};

type MappingRow = {
  id: string;
  mapping_type: AccountingMappingType;
  source_key: string;
  priority: number;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  accounting_accounts: ResolvedAccountingAccount | null;
};

export type MappingResolution = {
  accounts: Map<string, ResolvedAccountingAccount>;
  missing: string[];
  getAccount: (mappingType: AccountingMappingType, sourceKey: string) => ResolvedAccountingAccount | null;
};

function mappingKey(mappingType: AccountingMappingType, sourceKey: string) {
  return `${mappingType}:${sourceKey.trim().toLowerCase()}`;
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isEffective(row: MappingRow, today: string) {
  if (row.effective_from && row.effective_from > today) return false;
  if (row.effective_to && row.effective_to < today) return false;
  return true;
}

export async function resolveAccountingMappings(requirements: MappingRequirement[], client?: SupabaseClient): Promise<MappingResolution> {
  const uniqueRequirements = [...new Map(requirements.map((requirement) => [mappingKey(requirement.mappingType, requirement.sourceKey), requirement])).values()];
  const accounts = new Map<string, ResolvedAccountingAccount>();
  const missing: string[] = [];

  if (uniqueRequirements.length === 0) {
    return {
      accounts,
      missing,
      getAccount: () => null,
    };
  }

  const supabase = client ?? (await getSupabaseServerClient());
  const mappingTypes = [...new Set(uniqueRequirements.map((requirement) => requirement.mappingType))];
  const sourceKeys = [...new Set(uniqueRequirements.map((requirement) => requirement.sourceKey.trim().toLowerCase()))];
  const { data, error } = await supabase
    .from("accounting_mappings")
    .select(
      `
      id,
      mapping_type,
      source_key,
      priority,
      is_active,
      effective_from,
      effective_to,
      accounting_accounts(id, code, name, type, is_active)
    `,
    )
    .in("mapping_type", mappingTypes)
    .in("source_key", sourceKeys)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .returns<MappingRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const today = todayKey();
  const rows = data ?? [];

  for (const requirement of uniqueRequirements) {
    const key = mappingKey(requirement.mappingType, requirement.sourceKey);
    const row = rows.find(
      (candidate) =>
        mappingKey(candidate.mapping_type, candidate.source_key) === key &&
        isEffective(candidate, today) &&
        candidate.accounting_accounts?.is_active,
    );

    if (!row?.accounting_accounts) {
      missing.push(requirement.label);
      continue;
    }

    accounts.set(key, row.accounting_accounts);
  }

  return {
    accounts,
    missing,
    getAccount: (mappingType, sourceKey) => accounts.get(mappingKey(mappingType, sourceKey)) ?? null,
  };
}
