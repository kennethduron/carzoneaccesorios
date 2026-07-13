"use client";

import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { getDescendantAccountIds, wouldCreateAccountCycle } from "@/services/accounting/account-hierarchy";
import type { AccountingAccountHierarchyOption } from "@/types/accounting";

const rootLabel = "Sin cuenta padre / Cuenta raíz";
const maxVisibleOptions = 12;

type ParentAccountComboboxProps = {
  accounts: AccountingAccountHierarchyOption[];
  value: string | null;
  editingAccountId?: string | null;
  disabled?: boolean;
  onChange: (parentId: string | null) => void;
};

type SelectorItem =
  | { kind: "root" }
  | { kind: "account"; account: AccountingAccountHierarchyOption };

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function accountLabel(account: AccountingAccountHierarchyOption) {
  return `${account.code} — ${account.name}`;
}

export function ParentAccountCombobox({
  accounts,
  value,
  editingAccountId,
  disabled = false,
  onChange,
}: ParentAccountComboboxProps) {
  const inputId = useId();
  const listboxId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedAccount = accounts.find((account) => account.id === value) ?? null;

  const descendantIds = useMemo(
    () => editingAccountId ? getDescendantAccountIds(accounts, editingAccountId) : new Set<string>(),
    [accounts, editingAccountId],
  );

  const availableAccounts = useMemo(() => {
    return accounts
      .filter((account) => account.is_active)
      .filter((account) => account.id !== editingAccountId)
      .filter((account) => !descendantIds.has(account.id))
      .sort((left, right) => left.code.localeCompare(right.code, "es-HN", { numeric: true }));
  }, [accounts, descendantIds, editingAccountId]);

  const normalizedQuery = normalizeSearchText(query);
  const visibleItems = useMemo<SelectorItem[]>(() => {
    const includeRoot = !normalizedQuery || normalizeSearchText(rootLabel).includes(normalizedQuery);
    const accountLimit = includeRoot ? maxVisibleOptions - 1 : maxVisibleOptions;
    const matchingAccounts = availableAccounts
      .filter((account) => !normalizedQuery || normalizeSearchText(`${account.code} ${account.name}`).includes(normalizedQuery))
      .slice(0, accountLimit)
      .map((account): SelectorItem => ({ kind: "account", account }));

    return includeRoot ? [{ kind: "root" }, ...matchingAccounts] : matchingAccounts;
  }, [availableAccounts, normalizedQuery]);

  const createsCycle = wouldCreateAccountCycle(accounts, editingAccountId, value);
  const validationMessage = value && value === editingAccountId
    ? "Una cuenta no puede ser su propia cuenta padre."
    : createsCycle
      ? "La cuenta padre seleccionada es descendiente de esta cuenta."
      : "";

  function closeList() {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(0);
  }

  function selectItem(item: SelectorItem) {
    if (item.kind === "root") {
      onChange(null);
    } else if (item.account.id === editingAccountId) {
      return;
    } else {
      onChange(item.account.id);
    }

    closeList();
  }

  const closedValue = selectedAccount
    ? `${accountLabel(selectedAccount)}${selectedAccount.is_active ? "" : " (inactiva)"}`
    : rootLabel;

  return (
    <div
      className="relative min-w-0 sm:col-span-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeList();
      }}
    >
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium uppercase text-black/50">
        Cuenta padre
      </label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={isOpen && visibleItems[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined}
          aria-describedby={validationMessage ? errorId : descriptionId}
          aria-invalid={Boolean(validationMessage)}
          value={isOpen ? query : closedValue}
          placeholder="Buscar por código o nombre"
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => {
            setQuery("");
            setIsOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) => Math.min(current + 1, Math.max(visibleItems.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && isOpen && visibleItems[activeIndex]) {
              event.preventDefault();
              selectItem(visibleItems[activeIndex]);
            } else if (event.key === "Escape") {
              closeList();
            }
          }}
          className="w-full min-w-0 rounded-md border border-black/10 bg-white py-2 pl-9 pr-10 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:cursor-not-allowed disabled:bg-[#f4f4f5] disabled:text-black/45"
        />
        <button
          type="button"
          aria-label={isOpen ? "Cerrar lista de cuentas padre" : "Abrir lista de cuentas padre"}
          disabled={disabled}
          onClick={() => {
            setQuery("");
            setIsOpen((current) => !current);
            setActiveIndex(0);
          }}
          className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-black/50 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {validationMessage ? (
        <p id={errorId} className="mt-1 text-xs font-medium text-[#b91c25]" aria-live="polite">{validationMessage}</p>
      ) : (
        <p id={descriptionId} className="mt-1 text-xs text-black/45">Selecciona una cuenta activa o conserva la cuenta como raíz.</p>
      )}

      {isOpen && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-2 max-h-72 w-full min-w-0 overflow-y-auto overflow-x-hidden rounded-md border border-black/10 bg-white p-1 text-sm shadow-xl shadow-black/10"
        >
          {visibleItems.length > 0 ? visibleItems.map((item, index) => {
            const isSelected = item.kind === "root" ? value === null : item.account.id === value;
            const label = item.kind === "root" ? rootLabel : accountLabel(item.account);
            return (
              <button
                id={`${listboxId}-option-${index}`}
                key={item.kind === "root" ? "root" : item.account.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectItem(item)}
                className={`flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left ${
                  index === activeIndex ? "bg-[#fff1f2]" : "hover:bg-[#f4f4f5]"
                }`}
              >
                <span className="min-w-0 truncate font-semibold">{label}</span>
                {isSelected ? <Check size={16} className="shrink-0 text-[#166534]" /> : null}
              </button>
            );
          }) : (
            <p className="px-3 py-3 text-sm text-black/55">No hay cuentas activas que coincidan.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
