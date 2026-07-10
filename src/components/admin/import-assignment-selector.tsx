"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui";
import type { AssignmentSelectorKind, AssignmentSelectorOption } from "@/types/import-foundation";
import { normalizeImportLabel } from "@/utils/import-validation";

type ImportAssignmentSelectorProps = {
  kind: AssignmentSelectorKind;
  options: AssignmentSelectorOption[];
  value?: string | null;
  disabled?: boolean;
  onChange?: (option: AssignmentSelectorOption | null) => void;
};

export function ImportAssignmentSelector({ kind, options, value, disabled = false, onChange }: ImportAssignmentSelectorProps) {
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.id === value) ?? null;
  const label = kind === "customer" ? "Buscar cliente" : "Buscar proveedor";

  const visibleOptions = useMemo(() => {
    const needle = normalizeImportLabel(query);
    if (!needle) return options.slice(0, 12);

    return options
      .filter((option) =>
        normalizeImportLabel([option.name, option.email, option.phone, option.taxId, option.code].filter(Boolean).join(" ")).includes(needle),
      )
      .slice(0, 12);
  }, [options, query]);

  return (
    <div className="min-w-0 rounded-md border border-black/10 bg-white p-3">
      <label className="block text-xs font-semibold uppercase text-black/50">{label}</label>
      <div className="mt-2 flex items-center gap-2 rounded-md border border-black/10 bg-[#fafafa] px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
        <Search size={16} className="shrink-0 text-black/40" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
          placeholder="Nombre, correo, telefono, RTN o codigo futuro"
          className="border-0 bg-transparent px-0 py-0 focus:border-0 focus:ring-0"
        />
      </div>

      {selected ? (
        <div className="mt-3 rounded-md border border-[#2f6f3e]/20 bg-[#edf7ed] p-2 text-sm text-[#2f6f3e]">
          <p className="font-semibold">{selected.name}</p>
          <p className="text-xs">{secondaryText(selected)}</p>
        </div>
      ) : null}

      <div className="mt-3 max-h-64 overflow-auto rounded-md border border-black/10">
        {visibleOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange?.(option)}
            className={`block w-full min-w-0 border-b border-black/10 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#fff1f2] disabled:cursor-not-allowed disabled:opacity-55 ${value === option.id ? "bg-[#fff1f2]" : "bg-white"}`}
          >
            <span className="block break-words font-semibold">{option.name}</span>
            <span className="block break-words text-xs leading-5 text-black/55">{secondaryText(option)}</span>
          </button>
        ))}
        {visibleOptions.length === 0 ? <p className="px-3 py-4 text-sm text-black/50">Sin resultados para este filtro.</p> : null}
      </div>
    </div>
  );
}

function secondaryText(option: AssignmentSelectorOption) {
  const parts = [option.email, option.phone, option.taxId ? `RTN ${option.taxId}` : null, option.code ? `Codigo ${option.code}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "Sin datos secundarios";
}
