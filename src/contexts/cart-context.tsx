"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { CartItem, Product } from "@/types/commerce";
import { getProductPrice } from "@/utils/pricing";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useProductRegistry } from "@/contexts/product-registry-context";

type CartRow = {
  product: Product;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type CartContextValue = {
  cart: CartItem[];
  rows: CartRow[];
  cartMessage: string;
  subtotal: number;
  tax: number;
  total: number;
  cartCount: number;
  addToCart: (productId: string) => boolean;
  updateQuantity: (productId: string, delta: number) => boolean;
  removeFromCart: (productId: string) => void;
  clearCartMessage: () => void;
  clearCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const storageKey = "car-zone-cart";

function readStoredCart() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored) as CartItem[];
    return parsed.filter((item) => typeof item.productId === "string" && Number.isFinite(item.quantity));
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return [];
  }
}

function writeStoredCart(cart: CartItem[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(storageKey, JSON.stringify(cart));
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>(readStoredCart);
  const [cartMessage, setCartMessage] = useState("");
  const { priceMode } = usePriceMode();
  const { findProduct } = useProductRegistry();

  const rows = useMemo(() => {
    return cart
      .map((item) => {
        const product = findProduct(item.productId) ?? item.productSnapshot ?? null;
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
      .filter(Boolean) as CartRow[];
  }, [cart, findProduct, priceMode]);

  const subtotal = rows.reduce((sum, item) => sum + item.lineTotal, 0);
  const tax = subtotal * 0.15;
  const total = subtotal + tax;
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      rows,
      cartMessage,
      subtotal,
      tax,
      total,
      cartCount,
      addToCart(productId) {
        const product = findProduct(productId);
        if (!product || product.stock <= 0) {
          setCartMessage("Producto sin stock disponible.");
          return false;
        }

        let added = false;
        setCart((current) => {
          const existing = current.find((item) => item.productId === productId);
          const currentQuantity = existing?.quantity ?? 0;

          if (currentQuantity + 1 > product.stock) {
            setCartMessage(`Solo hay ${product.stock} unidades disponibles.`);
            return current;
          }

          if (existing) {
            const nextCart = current.map((item) =>
              item.productId === productId ? { ...item, quantity: item.quantity + 1, productSnapshot: product } : item,
            );
            writeStoredCart(nextCart);
            setCartMessage("");
            added = true;
            return nextCart;
          }
          const nextCart = [...current, { productId, quantity: 1, productSnapshot: product }];
          writeStoredCart(nextCart);
          setCartMessage("");
          added = true;
          return nextCart;
        });
        return added;
      },
      updateQuantity(productId, delta) {
        let updated = false;
        setCart((current) => {
          const existing = current.find((item) => item.productId === productId);
          const product = findProduct(productId) ?? existing?.productSnapshot ?? null;

          if (!product) {
            setCartMessage("Producto no encontrado.");
            return current;
          }

          const nextCart = current
            .map((item) => {
              if (item.productId !== productId) {
                return item;
              }

              const nextQuantity = Math.max(0, item.quantity + delta);
              if (nextQuantity > product.stock) {
                setCartMessage(`Solo hay ${product.stock} unidades disponibles.`);
                return item;
              }

              setCartMessage("");
              updated = true;
              return { ...item, quantity: nextQuantity, productSnapshot: product };
            })
            .filter((item) => item.quantity > 0);
          writeStoredCart(nextCart);
          return nextCart;
        });
        return updated;
      },
      removeFromCart(productId) {
        setCart((current) => {
          const nextCart = current.filter((item) => item.productId !== productId);
          writeStoredCart(nextCart);
          return nextCart;
        });
      },
      clearCartMessage() {
        setCartMessage("");
      },
      clearCart() {
        writeStoredCart([]);
        setCart([]);
        setCartMessage("");
      },
    }),
    [cart, cartCount, cartMessage, findProduct, rows, subtotal, tax, total],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useShoppingCart() {
  const context = useContext(CartContext);

  if (!context) {
    throw new Error("useShoppingCart must be used inside CartProvider");
  }

  return context;
}
