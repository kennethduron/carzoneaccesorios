"use client";

import { AsyncSearchCombobox } from "@/components/admin/async-search-combobox";
import type { PurchaseProductSearchResult } from "@/types/admin-search";
import { formatCurrency } from "@/utils/pricing";

export function PurchaseProductCombobox({
  value,
  selectedOption,
  onChange,
  disabled = false,
}: {
  value: string;
  selectedOption?: PurchaseProductSearchResult | null;
  onChange: (product: PurchaseProductSearchResult | null) => void;
  disabled?: boolean;
}) {
  return (
    <AsyncSearchCombobox
      endpoint="/api/admin/purchases/products/search"
      value={value}
      selectedOption={selectedOption}
      onChange={onChange}
      label="Producto"
      placeholder="Buscar por SKU, código, nombre o marca"
      emptyMessage="No hay productos de compras que coincidan."
      getLabel={(product) => `${product.sku}${product.internalCode && product.internalCode !== product.sku ? ` / ${product.internalCode}` : ""} — ${product.name}`}
      getDescription={(product) => [product.brand, `${product.availableStock} disponibles`, product.status].filter(Boolean).join(" · ")}
      getMeta={(product) =>
        product.isActive
          ? `Costo actual: ${formatCurrency(product.costPrice)}`
          : `Producto inactivo - Costo actual: ${formatCurrency(product.costPrice)}`
      }
      disabled={disabled}
    />
  );
}
