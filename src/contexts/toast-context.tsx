"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info" | "loading";

type ToastAction = {
  label: string;
  href: string;
};

type ToastInput = {
  title?: string;
  message: string;
  type?: ToastType;
  duration?: number;
  action?: ToastAction;
};

type ToastItem = Required<Pick<ToastInput, "message" | "type">> & {
  id: string;
  title?: string;
  action?: ToastAction;
};

type ConfirmInput = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "neutral";
};

type ToastContextValue = {
  notify: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  success: (message: string, input?: Omit<ToastInput, "message" | "type">) => string;
  error: (message: string, input?: Omit<ToastInput, "message" | "type">) => string;
  warning: (message: string, input?: Omit<ToastInput, "message" | "type">) => string;
  info: (message: string, input?: Omit<ToastInput, "message" | "type">) => string;
  loading: (message: string, input?: Omit<ToastInput, "message" | "type">) => string;
  confirm: (input: ConfirmInput) => Promise<boolean>;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function toastIcon(type: ToastType) {
  if (type === "success") {
    return <CheckCircle2 size={18} className="text-[#b91c25]" />;
  }

  if (type === "error") {
    return <XCircle size={18} className="text-[#9b341b]" />;
  }

  if (type === "warning") {
    return <AlertTriangle size={18} className="text-[#9b6a1b]" />;
  }

  if (type === "loading") {
    return <Loader2 size={18} className="animate-spin text-[#e4252c]" />;
  }

  return <Info size={18} className="text-[#e4252c]" />;
}

function toastTone(type: ToastType) {
  if (type === "success") {
    return "border-[#b8d6d2] bg-[#f1faf8]";
  }

  if (type === "error") {
    return "border-[#f2b8a8] bg-[#fff6f2]";
  }

  if (type === "warning") {
    return "border-[#ead49a] bg-[#fff9e8]";
  }

  return "border-black/10 bg-white";
}

function humanizeMessage(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid input syntax for type uuid")) {
    return "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.";
  }

  if (normalized.includes("duplicate key") || normalized.includes("unique constraint")) {
    return "Este dato ya está registrado. Usa otro.";
  }

  if (normalized.includes("row-level security") || normalized.includes("rls") || normalized.includes("permission denied")) {
    return "No tienes permiso para realizar esta acción.";
  }

  if (
    normalized.includes("postgres") ||
    normalized.includes("supabase") ||
    normalized.includes("rpc") ||
    normalized.includes("constraint") ||
    normalized.includes("uuid")
  ) {
    return "No se pudo completar la acción. Revisa la información e intenta nuevamente.";
  }

  return message;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmInput & { resolve: (value: boolean) => void }) | null>(null);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    ({ title, message, type = "info", duration = type === "loading" ? 7000 : 4500, action }: ToastInput) => {
      const id = crypto.randomUUID();
      setToasts((current) => [{ id, title, message: humanizeMessage(message), type, action }, ...current].slice(0, 5));

      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }

      return id;
    },
    [dismiss],
  );

  const confirm = useCallback((input: ConfirmInput) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...input, resolve }));
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      notify,
      dismiss,
      success: (message, input) => notify({ ...input, message, type: "success" }),
      error: (message, input) => notify({ ...input, message, type: "error" }),
      warning: (message, input) => notify({ ...input, message, type: "warning" }),
      info: (message, input) => notify({ ...input, message, type: "info" }),
      loading: (message, input) => notify({ ...input, message, type: "loading" }),
      confirm,
    }),
    [confirm, dismiss, notify],
  );

  function closeConfirm(result: boolean) {
    confirmState?.resolve(result);
    setConfirmState(null);
  }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cz-layer-toast pointer-events-none fixed right-4 top-20 flex w-[min(92vw,390px)] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-lg border p-3 text-sm shadow-lg shadow-black/10 ${toastTone(toast.type)}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0">{toastIcon(toast.type)}</span>
              <div className="min-w-0 flex-1">
                {toast.title ? <p className="font-semibold text-[#080808]">{toast.title}</p> : null}
                <p className="text-[#3f423d]">{toast.message}</p>
                {toast.action ? (
                  <a href={toast.action.href} className="mt-2 inline-flex font-semibold text-[#e4252c]">
                    {toast.action.label}
                  </a>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="grid size-11 shrink-0 place-items-center rounded-md text-black/45 hover:bg-black/5"
                aria-label="Cerrar notificación"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {confirmState ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4">
          <section className="w-full max-w-md rounded-lg bg-white p-5 text-[#080808] shadow-xl">
            <h2 className="text-lg font-semibold">{confirmState.title}</h2>
            <p className="mt-2 text-sm text-black/65">{confirmState.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => closeConfirm(false)}
                className="rounded-md border border-black/10 px-4 py-2 text-sm font-medium"
              >
                {confirmState.cancelLabel ?? "Cancelar"}
              </button>
              <button
                type="button"
                onClick={() => closeConfirm(true)}
                className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
                  confirmState.tone === "danger" ? "bg-[#9b341b]" : "bg-[#080808]"
                }`}
              >
                {confirmState.confirmLabel ?? "Confirmar"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast debe usarse dentro de ToastProvider");
  }

  return context;
}


