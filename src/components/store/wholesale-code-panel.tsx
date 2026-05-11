"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { LogIn, Tag, X } from "lucide-react";
import { validateWholesaleCodeAction } from "@/app/actions/wholesale";
import { usePriceMode } from "@/contexts/price-mode-context";

export function WholesaleCodePanel() {
  const [code, setCode] = useState("");
  const handledPendingCodeRef = useRef("");
  const [loginHref, setLoginHref] = useState("");
  const [message, setMessage] = useState("La tienda muestra precio al detalle por defecto.");
  const [messageType, setMessageType] = useState<"neutral" | "success" | "error">("neutral");
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { wholesaleAccount, activateWholesaleMode, clearWholesaleMode } = usePriceMode();

  const buildReturnPath = useCallback((nextCode: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("wholesaleCode", nextCode);
    const queryString = params.toString();
    return queryString ? `${pathname}?${queryString}` : pathname;
  }, [pathname, searchParams]);

  const clearPendingCodeFromUrl = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("wholesaleCode");
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }, [pathname, router, searchParams]);

  const validateCode = useCallback(async (rawCode: string, clearUrlCode = false) => {
    const normalizedCode = rawCode.trim().toUpperCase();
    const result = await validateWholesaleCodeAction(normalizedCode);

    if (result.requiresLogin) {
      clearWholesaleMode();
      setLoginHref(`/login?next=${encodeURIComponent(buildReturnPath(result.code ?? normalizedCode))}`);
      setMessage(result.message);
      setMessageType("neutral");
      return;
    }

    if (!result.ok || !result.account) {
      clearWholesaleMode();
      setLoginHref("");
      setMessage(result.message);
      setMessageType("error");
      return;
    }

    activateWholesaleMode(result.account);
    setCode(result.account.code);
    setLoginHref("");
    setMessage(result.message);
    setMessageType("success");

    if (clearUrlCode) {
      clearPendingCodeFromUrl();
    }
  }, [activateWholesaleMode, buildReturnPath, clearPendingCodeFromUrl, clearWholesaleMode]);

  function applyCode() {
    startTransition(async () => {
      await validateCode(code);
    });
  }

  function clearCode() {
    clearWholesaleMode();
    setCode("");
    setLoginHref("");
    setMessage("Modo mayorista desactivado. La tienda vuelve a precio al detalle.");
    setMessageType("neutral");
  }

  function cancelLoginPrompt() {
    clearWholesaleMode();
    setLoginHref("");
    setMessage("Activacion mayorista cancelada. La tienda mantiene precio al detalle.");
    setMessageType("neutral");
  }

  useEffect(() => {
    const pendingCode = searchParams.get("wholesaleCode")?.trim() ?? "";
    if (!pendingCode || pendingCode === handledPendingCodeRef.current) {
      return;
    }

    handledPendingCodeRef.current = pendingCode;
    startTransition(async () => {
      await validateCode(pendingCode, true);
    });
  }, [searchParams, validateCode]);

  return (
    <>
      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <Tag size={18} />
          <h2 className="font-semibold">Eres mayorista? Ingresa tu codigo</h2>
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
            {isPending ? "Validando" : "Aplicar codigo"}
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
            <p>Codigo: {wholesaleAccount.code}</p>
            <button onClick={clearCode} className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[#9b341b]">
              <X size={16} />
              Quitar mayorista
            </button>
          </div>
        ) : null}
      </section>

      {loginHref ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4" role="presentation">
          <section
            aria-labelledby="wholesale-login-title"
            aria-modal="true"
            role="dialog"
            className="w-full max-w-md rounded-lg border border-black/10 bg-white p-5 text-[#1c1d1b] shadow-xl"
          >
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#e8f3f2] text-[#1e5960]">
                <Tag size={18} />
              </div>
              <div>
                <h2 id="wholesale-login-title" className="text-lg font-semibold">
                  Código mayorista válido
                </h2>
                <p className="mt-2 text-sm text-black/60">
                  Código válido. Inicia sesión con tu cuenta mayorista para activar precios.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <Link
                href={loginHref}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-[#1c1d1b] px-4 py-2 text-sm font-medium text-white"
              >
                <LogIn size={16} />
                Iniciar sesion
              </Link>
              <button
                onClick={cancelLoginPrompt}
                className="rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-medium text-[#1c1d1b] hover:bg-[#f7f7f2]"
              >
                Cancelar
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
