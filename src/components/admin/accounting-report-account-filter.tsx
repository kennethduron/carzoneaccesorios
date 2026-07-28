"use client";

import { useState } from "react";
import { AccountingAccountCombobox } from "@/components/admin/accounting-account-combobox";
import type { AccountingAccountSearchResult } from "@/types/admin-search";
import type { AccountingReportAccount } from "@/types/accounting-reports";

function toSearchResult(account: AccountingReportAccount | null): AccountingAccountSearchResult | null {
  if (!account) return null;
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    accountType: account.type,
    normalBalance: account.normal_balance,
    isActive: account.is_active,
    parentId: null,
    isSelectable: account.is_active,
  };
}

export function AccountingReportAccountFilter({ account }: { account: AccountingReportAccount | null }) {
  const [selected, setSelected] = useState<AccountingAccountSearchResult | null>(() => toSearchResult(account));
  return (
    <div>
      <input type="hidden" name="account" value={selected?.id ?? ""} />
      <AccountingAccountCombobox value={selected?.id ?? ""} selectedOption={selected} onChange={setSelected} label="Cuenta" />
    </div>
  );
}
