"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getCartProductsAction } from "@/app/actions/commercial-context";
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
  isResolvingCart: boolean;
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

    const parsed = JSON.parse(stored) as Array<Partial<CartItem>>;
    const validCart: CartItem[] = parsed
      .filter(
        (item) =>
          typeof item.productId === "string" &&
          isUuid(item.productId) &&
          Number.isFinite(item.quantity) &&
          Number(item.quantity) > 0,
      )
      .map((item) => ({
        productId: item.productId as string,
        quantity: Math.max(1, Math.floor(Number(item.quantity))),
      }));

    if (validCart.length !== parsed.length || parsed.some((item) => "productSnapshot" in item)) {
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
  const [resolvedCartProducts, setResolvedCartProducts] = useState<Record<string, Product>>({});
  const [resolvedCartRequestKey, setResolvedCartRequestKey] = useState("");
  const { priceMode, commercialContext } = usePriceMode();
  const { findProduct, registerProducts } = useProductRegistry();
  const toast = useToast();
  const productIdsKey = useMemo(
    () => Array.from(new Set(cart.map((item) => item.productId))).sort().join(","),
    [cart],
  );
  const commercialSignature = `${commercialContext.contextToken}:${commercialContext.commercialVersion ?? "guest"}`;
  const cartRequestKey = `${commercialSignature}:${productIdsKey}`;
  const isResolvingCart = Boolean(productIdsKey) && resolvedCartRequestKey !== cartRequestKey;
  const previousCommercialSignature = useRef(commercialSignature);

  useEffect(() => {
    let cancelled = false;
    const productIds = productIdsKey ? productIdsKey.split(",") : [];

    if (productIds.length === 0) {
      previousCommercialSignature.current = commercialSignature;
      return () => {
        cancelled = true;
      };
    }

    void getCartProductsAction(productIds)
      .then((products) => {
        if (cancelled) return;
        registerProducts(products);
        setResolvedCartProducts(
          Object.fromEntries(products.map((product) => [product.id, product])),
        );
        if (previousCommercialSignature.current !== commercialSignature) {
          const message = "Actualizamos los precios según tu cuenta actual.";
          setCartMessage(message);
          toast.info(message);
        }
        previousCommercialSignature.current = commercialSignature;
      })
      .finally(() => {
        if (!cancelled) setResolvedCartRequestKey(cartRequestKey);
      });

    return () => {
      cancelled = true;
    };
  }, [cartRequestKey, commercialSignature, productIdsKey, registerProducts, toast]);

  const rows = useMemo(() => {
    return cart
      .map((item) => {
        if (!isUuid(item.productId)) {
          return null;
        }

        const product = resolvedCartProducts[item.productId] ?? null;
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
  }, [cart, priceMode, resolvedCartProducts]);

  const productsTotal = rows.reduce((sum, item) => sum + item.lineTotal, 0);
  const includedTax = calculateIncludedTaxBreakdown(productsTotal);
  const subtotal = includedTax.subtotalBeforeTax;
  const tax = includedTax.includedTax;
  const total = includedTax.totalWithTax;
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const invalidItemCount = isResolvingCart ? 0 : Math.max(0, cart.length - rows.length);
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
      isResolvingCart,
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
              item.productId === productId ? { productId, quantity: nextQuantity } : item,
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
          const nextCart = [
            ...current,
            { productId, quantity: shouldApplyWholesaleMinimum ? minimumQuantity : 1 },
          ];
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
          const product = resolvedCartProducts[productId] ?? null;

          if (!product) {
            const message = isResolvingCart
              ? "Estamos actualizando este producto. Intenta de nuevo."
              : "Producto no encontrado.";
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
              return { productId: item.productId, quantity: nextQuantity };
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
          const nextCart = current.filter(
            (item) => isUuid(item.productId) && Boolean(resolvedCartProducts[item.productId]),
          );
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
    [
      cart,
      cartCount,
      cartMessage,
      findProduct,
      invalidItemCount,
      isResolvingCart,
      priceMode,
      resolvedCartProducts,
      rows,
      subtotal,
      tax,
      toast,
      total,
      wholesaleQuantityIssues,
    ],
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

