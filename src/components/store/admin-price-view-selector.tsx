"use client";

import { useAdminPriceView } from "@/contexts/admin-price-view-context";
import type { AdminPriceViewMode } from "@/types/admin-price-view";

const options: Array<{ mode: AdminPriceViewMode; label: string }> = [
  { mode: "retail", label: "Detalle" },
  { mode: "wholesale", label: "Mayorista" },
];

export function AdminPriceViewSelector() {
  const { eligible, mode, pendingMode, error, setMode } = useAdminPriceView();
  if (!eligible) return null;

  return (
    <section className="mx-3 my-2 rounded-md border border-black/10 bg-[#f4f4f5] p-3" aria-label="Vista administrativa de precios">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/55">Vista de precios</p>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-white p-1" role="radiogroup" aria-label="Seleccionar tarifa visible">
        {options.map((option) => {
          const selected = mode === option.mode;
          const className = "min-h-10 rounded px-2 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-65 " +
            (selected ? "bg-[#080808] text-white" : "text-black/65 hover:bg-[#fff1f2] hover:text-[#b91c25]");
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={pendingMode !== null}
              onClick={() => setMode(option.mode)}
              className={className}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-4 text-black/55">{pendingMode ? "Actualizando vista…" : "Solo cambia los precios que ves."}</p>
      {error ? <p className="mt-2 text-xs font-medium text-[#b91c25]" role="alert">{error}</p> : null}
    </section>
  );
}
