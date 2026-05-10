"use client";

import { useState, useTransition } from "react";
import { Tag, X } from "lucide-react";
import { validateWholesaleCodeAction } from "@/app/actions/wholesale";
import { usePriceMode } from "@/contexts/price-mode-context";

export function WholesaleCodePanel() {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("La tienda muestra precio al detalle por defecto.");
  const [messageType, setMessageType] = useState<"neutral" | "success" | "error">("neutral");
  const [isPending, startTransition] = useTransition();
  const { wholesaleAccount, activateWholesaleMode, clearWholesaleMode } = usePriceMode();

  function applyCode() {
    startTransition(async () => {
      const result = await validateWholesaleCodeAction(code);
      if (!result.ok || !result.account) {
        clearWholesaleMode();
        setMessage(`${result.message} Se mantiene precio al detalle.`);
        setMessageType("error");
        return;
      }

      activateWholesaleMode(result.account);
      setCode(result.account.code);
      setMessage(`Código aplicado correctamente. ${result.account.businessName}: Precio mayorista activo.`);
      setMessageType("success");
    });
  }

  function clearCode() {
    clearWholesaleMode();
    setCode("");
    setMessage("Modo mayorista desactivado. La tienda vuelve a precio al detalle.");
    setMessageType("neutral");
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Tag size={18} />
        <h2 className="font-semibold">¿Eres mayorista? Ingresa tu código</h2>
      </div>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Ej: MAYOREO-LOPEZ2026"
          className="min-w-0 flex-1 rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
        />
        <button
          onClick={applyCode}
          disabled={isPending}
          className="rounded-md bg-[#d55d3b] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {isPending ? "Validando" : "Aplicar código"}
        </button>
      </div>
      <p
        className={`mt-3 rounded-md px-3 py-2 text-sm ${
          messageType === "success"
            ? "bg-[#e8f3f2] text-[#1e5960]"
            : messageType === "error"
              ? "bg-[#fff0ea] text-[#9b341b]"
              : "bg-[#f7f7f2] text-black/60"
        }`}
      >
        {message}
      </p>
      {wholesaleAccount ? (
        <div className="mt-3 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/65">
          <p className="font-medium text-[#1c1d1b]">{wholesaleAccount.businessName}</p>
          <p>Código: {wholesaleAccount.code}</p>
          <button onClick={clearCode} className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[#9b341b]">
            <X size={16} />
            Quitar mayorista
          </button>
        </div>
      ) : null}
    </section>
  );
}
