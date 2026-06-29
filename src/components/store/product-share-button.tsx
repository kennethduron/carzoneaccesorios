"use client";

import { useState } from "react";
import { CheckCircle2, Copy, Share2 } from "lucide-react";

type ProductShareButtonProps = {
  productName: string;
  description?: string | null;
  url?: string;
  label?: string;
  fallbackText?: string;
  className?: string;
};

type ShareCapableNavigator = Navigator & {
  share?: (data: ShareData) => Promise<void>;
};

export function ProductShareButton({
  productName,
  description,
  url,
  label = "Compartir",
  fallbackText = "Link copiado al portapapeles",
  className = "",
}: ProductShareButtonProps) {
  const [feedback, setFeedback] = useState("");
  const [manualUrl, setManualUrl] = useState("");

  async function handleShare() {
    const shareUrl = getShareUrl(url);
    const text = description?.trim() || `Mira este producto: ${productName}`;
    const shareData: ShareData = {
      title: productName,
      text,
      url: shareUrl,
    };

    setFeedback("");
    setManualUrl("");

    try {
      const shareNavigator = navigator as ShareCapableNavigator;
      if (typeof shareNavigator.share === "function") {
        await shareNavigator.share(shareData);
        setFeedback("Listo para compartir");
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
    }

    const copied = await copyShareUrl(shareUrl);
    if (copied) {
      setFeedback(fallbackText);
      return;
    }

    setFeedback("Copia este enlace:");
    setManualUrl(shareUrl);
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={handleShare}
        className={`inline-flex w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-4 py-3 text-sm font-semibold hover:border-[#e4252c]/30 hover:bg-[#fff1f2] ${className}`}
      >
        {feedback ? <CheckCircle2 size={18} /> : <Share2 size={18} />}
        {label}
      </button>
      {feedback ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-black/60">
          {manualUrl ? <Copy size={14} /> : null}
          <span>{feedback}</span>
        </p>
      ) : null}
      {manualUrl ? (
        <p className="mt-1 break-all rounded-md border border-black/10 bg-black/[0.03] px-2 py-1 text-xs text-black/65">{manualUrl}</p>
      ) : null}
    </div>
  );
}

function getShareUrl(url?: string) {
  return url?.trim() || window.location.href;
}

async function copyShareUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // Fall through to the legacy copy path.
    }
  }

  return copyWithTemporarySelection(url);
}

function copyWithTemporarySelection(value: string) {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-9999px";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}
