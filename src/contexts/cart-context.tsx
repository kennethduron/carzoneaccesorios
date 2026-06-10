"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { CartItem, Product } from "@/types/commerce";
import { calculateIncludedTaxBreakdown } from "@/utils/included-tax";
import { getProductPrice } from "@/utils/pricing";
import {
  getWholesaleMinimumQuantity,
  requiresWholesaleMinimumQuantity,
  wholesaleMinimumQuantityMessage,
} from "@/utils/wholesale-quantity";
import { usePriceMode } from "@/contexts/price-mode-context";
import { useProductRegistry } from "@/contexts/product-registry-context";
import { useToast } from "@/contexts/toast-context";

type CartRow = {
  product: Product;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type WholesaleQuantityIssue = {
  productId: string;
  productName: string;
  currentQuantity: number;
  minimumQuantity: number;
};

type CartContextValue = {
  cart: CartItem[];
  rows: CartRow[];
  wholesaleQuantityIssues: WholesaleQuantityIssue[];
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

function productSnapshotChanged(current: Product | undefined, next: Product) {
  return (
    !current ||
    current.name !== next.name ||
    current.sku !== next.sku ||
    current.stock !== next.stock ||
    current.retail_price !== next.retail_price ||
    current.wholesale_price !== next.wholesale_price ||
    current.wholesale_min_quantity !== next.wholesale_min_quantity
  );
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>(readStoredCart);
  const [cartMessage, setCartMessage] = useState("");
  const { priceMode } = usePriceMode();
  const { findProduct } = useProductRegistry();
  const toast = useToast();

  useEffect(() => {
    let changed = false;
    const nextCart = cart.map((item) => {
      const product = isUuid(item.productId) ? findProduct(item.productId) : null;
      if (!product || !productSnapshotChanged(item.productSnapshot, product)) {
        return item;
      }

      changed = true;
      return { ...item, productSnapshot: product };
    });

    if (!changed) {
      return;
    }

    const timeout = window.setTimeout(() => {
      writeStoredCart(nextCart);
      setCart(nextCart);
      const message = "Actualizamos los precios según tu cuenta actual.";
      setCartMessage(message);
      toast.info(message);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [cart, findProduct, toast]);

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

  const productsTotal = rows.reduce((sum, item) => sum + item.lineTotal, 0);
  const includedTax = calculateIncludedTaxBreakdown(productsTotal);
  const subtotal = includedTax.subtotalBeforeTax;
  const tax = includedTax.includedTax;
  const total = includedTax.totalWithTax;
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const invalidItemCount = Math.max(0, cart.length - rows.length);
  const wholesaleQuantityIssues = rows
    .filter((item) => requiresWholesaleMinimumQuantity(item.product, priceMode))
    .map((item) => ({
      productId: item.product.id,
      productName: item.product.name,
      currentQuantity: item.quantity,
      minimumQuantity: getWholesaleMinimumQuantity(item.product),
    }))
    .filter((item) => item.currentQuantity < item.minimumQuantity);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      rows,
      wholesaleQuantityIssues,
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
          const minimumQuantity = getWholesaleMinimumQuantity(product);
          const shouldApplyWholesaleMinimum = requiresWholesaleMinimumQuantity(product, priceMode);
          const nextQuantity = shouldApplyWholesaleMinimum
            ? Math.max(currentQuantity + 1, minimumQuantity)
            : currentQuantity + 1;

          if (nextQuantity > product.stock) {
            const message = `Solo hay ${product.stock} unidades disponibles.`;
            setCartMessage(message);
            toast.warning(message);
            return current;
          }

          if (existing) {
            const nextCart = current.map((item) =>
              item.productId === productId ? { ...item, quantity: nextQuantity, productSnapshot: product } : item,
            );
            writeStoredCart(nextCart);
            const message = shouldApplyWholesaleMinimum && nextQuantity === minimumQuantity
              ? wholesaleMinimumQuantityMessage(minimumQuantity)
              : "Cantidad actualizada en el carrito.";
            setCartMessage(message);
            toast.success(message, { action: { label: "Ver carrito", href: "/carrito" } });
            added = true;
            return nextCart;
          }
          const nextCart = [...current, { productId, quantity: shouldApplyWholesaleMinimum ? minimumQuantity : 1, productSnapshot: product }];
          writeStoredCart(nextCart);
          const message = shouldApplyWholesaleMinimum
            ? wholesaleMinimumQuantityMessage(minimumQuantity)
            : "Producto agregado al carrito.";
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
              const minimumQuantity = getWholesaleMinimumQuantity(product);
              if (
                requiresWholesaleMinimumQuantity(product, priceMode) &&
                nextQuantity > 0 &&
                nextQuantity < minimumQuantity
              ) {
                const message = wholesaleMinimumQuantityMessage(minimumQuantity);
                setCartMessage(message);
                toast.warning(message);
                return item;
              }

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
    [cart, cartCount, cartMessage, findProduct, invalidItemCount, priceMode, rows, subtotal, tax, toast, total, wholesaleQuantityIssues],
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

