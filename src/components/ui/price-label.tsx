import type { PriceMode } from "@/types/commerce";

type PriceLabelProps = {
  mode: PriceMode;
};

export function PriceLabel({ mode }: PriceLabelProps) {
  return (
    <span className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
      {mode === "wholesale" ? "Precio mayorista activo" : "Precio al detalle activo"}
    </span>
  );
}
