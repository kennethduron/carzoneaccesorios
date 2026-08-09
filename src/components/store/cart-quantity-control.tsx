"use client";

import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useShoppingCart } from "@/contexts/cart-context";
import { CART_MAX_QUANTITY, parseCartQuantityDraft } from "@/utils/cart-quantity";

export function CartQuantityControl({
  productId,
  productName,
  quantity,
  availableStock,
}: {
  productId: string;
  productName: string;
  quantity: number;
  availableStock: number;
}) {
  const { setQuantity, updateQuantity } = useShoppingCart();
  const [draft, setDraft] = useState(String(quantity));
  const [error, setError] = useState("");
  const errorId = useId();
  const maximum = Math.min(availableStock, CART_MAX_QUANTITY);

  function commitQuantity() {
    const raw = draft.trim();
    const requested = parseCartQuantityDraft(raw);
    if (requested === null) {
      setDraft(String(quantity));
      setError(raw ? "Ingresa una cantidad entera mayor que cero." : "La cantidad no puede quedar vacía.");
      return;
    }
    const result = setQuantity(productId, requested);
    if (!result.ok) {
      setDraft(String(quantity));
      setError(result.message);
      return;
    }
    setDraft(String(result.quantity ?? quantity));
    setError("");
  }

  function changeByButton(delta: number) {
    setError("");
    updateQuantity(productId, delta);
  }

  return (
    <div className="flex min-w-0 flex-col items-center">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => changeByButton(-1)}
          className="grid size-11 shrink-0 place-items-center rounded-md border border-black/10 transition-colors hover:bg-[#f4f4f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
          aria-label={`Disminuir cantidad de ${productName}`}
        >
          <Minus size={16} />
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          role="spinbutton"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commitQuantity}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitQuantity();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(String(quantity));
              setError("");
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              changeByButton(1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              changeByButton(-1);
            }
          }}
          aria-label={`Cantidad de ${productName}`}
          aria-valuemin={1}
          aria-valuemax={maximum}
          aria-valuenow={parseCartQuantityDraft(draft) ?? undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="h-11 w-[4.5rem] rounded-md border border-black/15 bg-white px-2 text-center text-sm font-semibold outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15"
        />
        <button
          type="button"
          onClick={() => changeByButton(1)}
          className="grid size-11 shrink-0 place-items-center rounded-md border border-black/10 transition-colors hover:bg-[#f4f4f5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"
          aria-label={`Aumentar cantidad de ${productName}`}
        >
          <Plus size={16} />
        </button>
      </div>
      {error ? <p id={errorId} role="alert" className="mt-1 max-w-56 text-center text-xs text-[#9b341b]">{error}</p> : null}
    </div>
  );
}
