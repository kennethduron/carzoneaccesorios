import { useMemo, useState } from "react";
import type { CartItem, PriceMode, Product } from "@/types/commerce";
import { calculateIncludedTaxBreakdown } from "@/utils/included-tax";
import { getProductPrice } from "@/utils/pricing";

export function useCart(products: Product[], priceMode: PriceMode) {
  const [cart, setCart] = useState<CartItem[]>([]);

  const rows = useMemo(() => {
    return cart
      .map((item) => {
        const product = products.find((entry) => entry.id === item.productId);
        if (!product) {
          return null;
        }

        const unitPrice = getProductPrice(product, priceMode);
        return {
          product,
          quantity: item.quantity,
          unitPrice,
          lineTotal: unitPrice * item.quantity,
        };
      })
      .filter(Boolean);
  }, [cart, priceMode, products]);

  const productsTotal = rows.reduce((sum, item) => sum + (item?.lineTotal ?? 0), 0);
  const includedTax = calculateIncludedTaxBreakdown(productsTotal);
  const subtotal = includedTax.subtotalBeforeTax;
  const tax = includedTax.includedTax;
  const total = includedTax.totalWithTax;
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  function addToCart(productId: string) {
    setCart((current) => {
      const existing = current.find((item) => item.productId === productId);
      if (existing) {
        return current.map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity + 1 } : item,
        );
      }
      return [...current, { productId, quantity: 1 }];
    });
  }

  function updateQuantity(productId: string, delta: number) {
    setCart((current) =>
      current
        .map((item) =>
          item.productId === productId
            ? { ...item, quantity: Math.max(0, item.quantity + delta) }
            : item,
        )
        .filter((item) => item.quantity > 0),
    );
  }

  return {
    cart,
    rows,
    subtotal,
    tax,
    total,
    cartCount,
    addToCart,
    updateQuantity,
  };
}
