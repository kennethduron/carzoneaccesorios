"use client";

import { AsyncSearchCombobox } from "@/components/admin/async-search-combobox";
import type { InventoryProductSearchResult } from "@/types/admin-search";

export function InventoryProductCombobox({
  value,
  selectedOption,
  onChange,
  disabled = false,
}: {
  value: string;
  selectedOption?: InventoryProductSearchResult | null;
  onChange: (product: InventoryProductSearchResult | null) => void;
  disabled?: boolean;
}) {
  return (
    <AsyncSearchCombobox
      endpoint="/api/admin/inventory/products/search"
      value={value}
      selectedOption={selectedOption}
      onChange={onChange}
      label="Producto"
      placeholder="Buscar por SKU, código, nombre o marca"
      emptyMessage="No hay productos de inventario que coincidan."
      getLabel={(product) => `${product.sku}${product.internalCode && product.internalCode !== product.sku ? ` / ${product.internalCode}` : ""} — ${product.name}`}
      getDescription={(product) => [product.brand, product.categoryName, `${product.availableStock} disponibles`].filter(Boolean).join(" · ")}
      getMeta={(product) => product.isActive ? null : "Producto inactivo"}
      disabled={disabled}
    />
  );
}
