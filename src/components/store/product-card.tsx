import Image from "next/image";
import { Plus } from "lucide-react";
import type { PriceMode, Product } from "@/types/commerce";
import { formatCurrency, getProductPrice } from "@/utils/pricing";
import { Button } from "@/components/ui/button";

type ProductCardProps = {
  product: Product;
  priceMode: PriceMode;
  onAdd: (productId: string) => void;
  onOpen: (product: Product) => void;
};

export function ProductCard({ product, priceMode, onAdd, onOpen }: ProductCardProps) {
  return (
    <article className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <button onClick={() => onOpen(product)} className="block w-full text-left">
        <Image
          src={product.image}
          alt={product.name}
          width={900}
          height={520}
          className="h-44 w-full object-cover"
        />
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-black/45">{product.sku}</p>
              <h2 className="mt-1 text-lg font-semibold">{product.name}</h2>
            </div>
            <span className="rounded-md bg-[#f0ede2] px-2 py-1 text-xs">{product.category}</span>
          </div>
          <p className="line-clamp-2 text-sm text-black/60">{product.description}</p>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs text-black/45">
                {priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}
              </p>
              <p className="text-2xl font-semibold">
                {formatCurrency(getProductPrice(product, priceMode))}
              </p>
            </div>
            <p className="text-sm text-black/50">Stock {product.stock}</p>
          </div>
        </div>
      </button>
      <div className="border-t border-black/10 p-4">
        <Button onClick={() => onAdd(product.id)} variant="dark" className="w-full py-3">
          <Plus size={18} />
          Agregar
        </Button>
      </div>
    </article>
  );
}
