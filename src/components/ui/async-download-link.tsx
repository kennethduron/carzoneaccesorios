"use client";

import { useRef, useState, type ReactNode } from "react";
import { Download, LoaderCircle } from "lucide-react";

type AsyncDownloadLinkProps = {
  href: string;
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
};

function downloadName(response: Response, href: string) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const fallback = new URL(href, window.location.href).pathname.split("/").pop() || "descarga";
  try {
    return decodeURIComponent(encoded ?? plain ?? fallback);
  } catch {
    return plain ?? fallback;
  }
}

export function AsyncDownloadLink({
  href,
  children,
  pendingLabel = "Generando archivo…",
  className = "",
  disabled = false,
  icon = <Download aria-hidden size={16} />,
}: AsyncDownloadLinkProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function startDownload() {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(href, { credentials: "same-origin" });
      if (!response.ok) throw new Error("No se pudo generar el archivo.");
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = downloadName(response, href);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el archivo.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <span className="inline-grid gap-1">
      <button
        type="button"
        onClick={() => void startDownload()}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md disabled:cursor-not-allowed disabled:opacity-55 ${className}`}
      >
        {pending ? <LoaderCircle aria-hidden size={16} className="animate-spin motion-reduce:animate-none" /> : icon}
        <span role={pending ? "status" : undefined} aria-live={pending ? "polite" : undefined}>
          {pending ? pendingLabel : children}
        </span>
      </button>
      {error ? <span role="alert" className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
