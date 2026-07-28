"use client";

import { AsyncSearchCombobox } from "@/components/admin/async-search-combobox";
import type { AccountingAccountSearchResult } from "@/types/admin-search";

const accountTypeLabels: Record<AccountingAccountSearchResult["accountType"], string> = {
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio",
  revenue: "Ingreso",
  cost: "Costo",
  expense: "Gasto",
};

export function AccountingAccountCombobox({
  value,
  selectedOption,
  onChange,
  disabled = false,
  label = "Cuenta",
}: {
  value: string;
  selectedOption?: AccountingAccountSearchResult | null;
  onChange: (account: AccountingAccountSearchResult | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <AsyncSearchCombobox
      endpoint="/api/admin/accounting/accounts/search"
      value={value}
      selectedOption={selectedOption}
      onChange={onChange}
      label={label}
      placeholder="Buscar por código o nombre"
      emptyMessage="No hay cuentas autorizadas que coincidan."
      getLabel={(account) => `${account.code} — ${account.name}`}
      getDescription={(account) => `${accountTypeLabels[account.accountType]} · Naturaleza ${account.normalBalance === "debit" ? "deudora" : "acreedora"}`}
      getMeta={(account) => account.isActive && account.isSelectable ? null : "Cuenta no seleccionable"}
      disabled={disabled}
      required
    />
  );
}
