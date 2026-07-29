"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui";
import type { CrmCustomerOption } from "@/types/crm";
import type { WholesaleCustomerType } from "@/types/wholesale";
import { formatCurrency } from "@/utils/pricing";

export function WholesaleGrantDialog({
  customer,
  type,
  firstWholesaleMinimum,
  pending,
  onCancel,
  onConfirm,
}: {
  customer: CrmCustomerOption;
  type: WholesaleCustomerType;
  firstWholesaleMinimum: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const titleId = useId();
  const reasonId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      returnFocusRef.current?.focus();
    };
  }, [onCancel, pending]);

  const displayName = customer.business_name || customer.company_name || customer.contact_name;
  const valid = reason.trim().length >= 5 && reason.trim().length <= 500;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto bg-black/50 px-4 py-6" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onCancel();
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-3rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-[#e4252c]">Otorgamiento directo</p>
            <h2 id={titleId} className="mt-1 text-xl font-semibold">Otorgar mayoreo a {displayName}</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={pending} aria-label="Cerrar diálogo" className="grid size-11 shrink-0 place-items-center rounded-md border border-black/10 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 rounded-md bg-[#f4f4f5] p-4 text-sm text-black/65">
          {type === "new"
            ? `El cliente quedará como mayorista nuevo y deberá completar una primera compra mínima de ${formatCurrency(firstWholesaleMinimum)}.`
            : "El cliente quedará como mayorista existente y no tendrá requisito de primera compra mínima."}
        </div>
        <label htmlFor={reasonId} className="mt-4 block text-sm font-semibold">
          Motivo administrativo
        </label>
        <textarea
          ref={inputRef}
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value.slice(0, 500))}
          rows={4}
          aria-describedby={`${reasonId}-help`}
          className="mt-2 w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          placeholder="Explica por qué se otorga el acceso directamente."
        />
        <p id={`${reasonId}-help`} className="mt-1 text-xs text-black/50">Entre 5 y 500 caracteres. {reason.length}/500</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancelar</Button>
          <Button type="button" variant="dark" onClick={() => onConfirm(reason.trim())} disabled={pending || !valid}>
            {pending ? "Otorgando..." : `Otorgar como ${type === "existing" ? "existente" : "nuevo"}`}
          </Button>
        </div>
      </section>
    </div>
  );
}
