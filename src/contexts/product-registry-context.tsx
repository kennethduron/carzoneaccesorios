"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { products as fallbackProducts } from "@/lib/commerce";
import type { Product } from "@/types/commerce";

type ProductRegistryValue = {
  registerProducts: (products: Product[]) => void;
  findProduct: (productId: string) => Product | null;
};

const ProductRegistryContext = createContext<ProductRegistryValue | null>(null);

export function ProductRegistryProvider({ children }: { children: React.ReactNode }) {
  const [registeredProducts, setRegisteredProducts] = useState<Record<string, Product>>(() =>
    Object.fromEntries(fallbackProducts.map((product) => [product.id, product])),
  );

  const registerProducts = useCallback((products: Product[]) => {
    if (products.length === 0) {
      return;
    }

    setRegisteredProducts((current) => {
      const next = { ...current };
      products.forEach((product) => {
        next[product.id] = product;
      });
      return next;
    });
  }, []);

  const value = useMemo<ProductRegistryValue>(
    () => ({
      registerProducts,
      findProduct(productId) {
        return registeredProducts[productId] ?? null;
      },
    }),
    [registerProducts, registeredProducts],
  );

  return <ProductRegistryContext.Provider value={value}>{children}</ProductRegistryContext.Provider>;
}

export function useProductRegistry() {
  const context = useContext(ProductRegistryContext);

  if (!context) {
    throw new Error("useProductRegistry must be used inside ProductRegistryProvider");
  }

  return context;
}
