"use client";

import { createContext, useContext, useMemo, useState } from "react";
import type { CartItem, Product } from "@/types/commerce";
import { getProductPrice } from "@/utils/pricing";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useProductRegistry } from "@/contexts/product-registry-context";
import { useToast } from "@/contexts/toast-context";

type CartRow = {
  product: Product;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type CartContextValue = {
  cart: CartItem[];
  rows: CartRow[];
  invalidItemCount: number;
  cartMessage: string;
  subtotal: number;
  tax: number;
  total: number;
  cartCount: number;
  addToCart: (productId: string) => boolean;
  updateQuantity: (productId: string, delta: number) => boolean;
  removeFromCart: (productId: string) => void;
  clearInvalidCartItems: () => void;
  clearCartMessage: () => void;
  clearCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const storageKey = "car-zone-cart";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return uuidPattern.test(value);
}

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
    const validCart = parsed.filter(
      (item) => typeof item.productId === "string" && isUuid(item.productId) && Number.isFinite(item.quantity),
    );

    if (validCart.length !== parsed.length) {
      window.sessionStorage.setItem(storageKey, JSON.stringify(validCart));
    }

    return validCart;
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
  const toast = useToast();

  const rows = useMemo(() => {
    return cart
      .map((item) => {
        if (!isUuid(item.productId)) {
          return null;
        }

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
  const invalidItemCount = Math.max(0, cart.length - rows.length);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      rows,
      invalidItemCount,
      cartMessage,
      subtotal,
      tax,
      total,
      cartCount,
      addToCart(productId) {
        if (!isUuid(productId)) {
          const message = "Este producto no está disponible para compra.";
          setCartMessage(message);
          toast.error(message);
          return false;
        }

        const product = findProduct(productId);
        if (!product || product.stock <= 0) {
          const message = "Este producto no tiene stock disponible.";
          setCartMessage(message);
          toast.warning(message);
          return false;
        }

        let added = false;
        setCart((current) => {
          const existing = current.find((item) => item.productId === productId);
          const currentQuantity = existing?.quantity ?? 0;

          if (currentQuantity + 1 > product.stock) {
            const message = `Solo hay ${product.stock} unidades disponibles.`;
            setCartMessage(message);
            toast.warning(message);
            return current;
          }

          if (existing) {
            const nextCart = current.map((item) =>
              item.productId === productId ? { ...item, quantity: item.quantity + 1, productSnapshot: product } : item,
            );
            writeStoredCart(nextCart);
            const message = "Cantidad actualizada en el carrito.";
            setCartMessage(message);
            toast.success(message, { action: { label: "Ver carrito", href: "/carrito" } });
            added = true;
            return nextCart;
          }
          const nextCart = [...current, { productId, quantity: 1, productSnapshot: product }];
          writeStoredCart(nextCart);
          const message = "Producto agregado al carrito.";
          setCartMessage(message);
          toast.success(message, { action: { label: "Ver carrito", href: "/carrito" } });
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
            const message = "Producto no encontrado.";
            setCartMessage(message);
            toast.error(message);
            return current;
          }

          const nextCart = current
            .map((item) => {
              if (item.productId !== productId) {
                return item;
              }

              const nextQuantity = Math.max(0, item.quantity + delta);
              if (nextQuantity > product.stock) {
                const message = `Solo hay ${product.stock} unidades disponibles.`;
                setCartMessage(message);
                toast.warning(message);
                return item;
              }

              setCartMessage("Cantidad actualizada en el carrito.");
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
          toast.info("Producto eliminado del carrito.");
          return nextCart;
        });
      },
      clearInvalidCartItems() {
        setCart((current) => {
          const nextCart = current.filter((item) => isUuid(item.productId) && (findProduct(item.productId) || item.productSnapshot));
          writeStoredCart(nextCart);
          setCartMessage("");
          toast.info("Productos invalidos eliminados del carrito.");
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
    [cart, cartCount, cartMessage, findProduct, invalidItemCount, rows, subtotal, tax, toast, total],
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
