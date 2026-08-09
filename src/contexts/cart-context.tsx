"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { CART_MAX_QUANTITY, validateCartQuantity } from "@/utils/cart-quantity";

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

export type CartQuantityResult = {
  ok: boolean;
  code: "UPDATED" | "UNCHANGED" | "PRODUCT_UNAVAILABLE" | "QUANTITY_INVALID" | "QUANTITY_TOO_HIGH" | "STOCK_EXCEEDED" | "WHOLESALE_MINIMUM";
  message: string;
  quantity?: number;
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
  setQuantity: (productId: string, requestedQuantity: number) => CartQuantityResult;
  updateQuantity: (productId: string, delta: number) => boolean;
  removeFromCart: (productId: string) => void;
  clearInvalidCartItems: () => void;
  clearCartMessage: () => void;
  clearCart: () => void;
  refreshCart: () => void;
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
        quantity: Math.min(CART_MAX_QUANTITY, Math.max(1, Math.floor(Number(item.quantity)))),
      }));

    if (
      validCart.length !== parsed.length ||
      parsed.some((item) => "productSnapshot" in item) ||
      validCart.some((item, index) => item.quantity !== Number(parsed[index]?.quantity))
    ) {
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
  const [cart, setCart] = useState<CartItem[]>([]);
  const cartRef = useRef<CartItem[]>([]);
  const [cartMessage, setCartMessage] = useState("");
  const [resolvedCartProducts, setResolvedCartProducts] = useState<Record<string, Product>>({});
  const [resolvedCartRequestKey, setResolvedCartRequestKey] = useState("");
  const [cartRefreshVersion, setCartRefreshVersion] = useState(0);
  const { priceMode, commercialContext } = usePriceMode();
  const { findProduct, registerProducts } = useProductRegistry();
  const toast = useToast();
  const productIdsKey = useMemo(
    () => Array.from(new Set(cart.map((item) => item.productId))).sort().join(","),
    [cart],
  );
  const commercialSignature = `${commercialContext.contextToken}:${commercialContext.commercialVersion ?? "guest"}`;
  const cartRequestKey = `${commercialSignature}:${productIdsKey}:${cartRefreshVersion}`;
  const isResolvingCart = Boolean(productIdsKey) && resolvedCartRequestKey !== cartRequestKey;
  const previousCommercialSignature = useRef(commercialSignature);

  useEffect(() => {
    let cancelled = false;
    const storedCart = readStoredCart();
    queueMicrotask(() => {
      if (cancelled) return;
      cartRef.current = storedCart;
      setCart(storedCart);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const commitCart = useCallback((nextCart: CartItem[]) => {
    cartRef.current = nextCart;
    writeStoredCart(nextCart);
    setCart(nextCart);
  }, []);

  const setQuantity = useCallback((productId: string, requestedQuantity: number): CartQuantityResult => {
    const product = resolvedCartProducts[productId] ?? null;
    if (!product) {
      const message = isResolvingCart
        ? "Estamos actualizando este producto. Intenta de nuevo."
        : "Producto no encontrado.";
      setCartMessage(message);
      return { ok: false, code: "PRODUCT_UNAVAILABLE", message };
    }
    const minimumQuantity = getWholesaleMinimumQuantity(product);
    const validation = validateCartQuantity({
      requestedQuantity,
      availableStock: product.stock,
      wholesaleMinimum: minimumQuantity,
      wholesaleMinimumApplies: requiresWholesaleMinimumQuantity(product, priceMode),
    });
    if (!validation.ok) {
      setCartMessage(validation.message);
      return validation;
    }

    const current = cartRef.current;
    const existing = current.find((item) => item.productId === productId);
    if (!existing) {
      const message = "Producto no encontrado en el carrito.";
      setCartMessage(message);
      return { ok: false, code: "PRODUCT_UNAVAILABLE", message };
    }
    if (existing.quantity === requestedQuantity) {
      return { ok: true, code: "UNCHANGED", message: "La cantidad ya estaba actualizada.", quantity: requestedQuantity };
    }

    commitCart(
      current.map((item) => item.productId === productId ? { ...item, quantity: requestedQuantity } : item),
    );
    const message = "Cantidad actualizada en el carrito.";
    setCartMessage(message);
    return { ok: true, code: "UPDATED", message, quantity: requestedQuantity };
  }, [commitCart, isResolvingCart, priceMode, resolvedCartProducts]);

  const addToCart = useCallback((productId: string) => {
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

    const current = cartRef.current;
    const existing = current.find((item) => item.productId === productId);
    const currentQuantity = existing?.quantity ?? 0;
    const minimumQuantity = getWholesaleMinimumQuantity(product);
    const shouldApplyWholesaleMinimum = requiresWholesaleMinimumQuantity(product, priceMode);
    const nextQuantity = shouldApplyWholesaleMinimum
      ? Math.max(currentQuantity + 1, minimumQuantity)
      : currentQuantity + 1;

    if (nextQuantity > Math.min(product.stock, CART_MAX_QUANTITY)) {
      const message = `Solo hay ${product.stock} unidades disponibles.`;
      setCartMessage(message);
      toast.warning(message);
      return false;
    }

    const nextCart = existing
      ? current.map((item) =>
          item.productId === productId ? { productId, quantity: nextQuantity } : item,
        )
      : [...current, { productId, quantity: shouldApplyWholesaleMinimum ? minimumQuantity : 1 }];
    commitCart(nextCart);
    const message = existing
      ? shouldApplyWholesaleMinimum && nextQuantity === minimumQuantity
        ? wholesaleMinimumQuantityMessage(minimumQuantity)
        : "Cantidad actualizada en el carrito."
      : shouldApplyWholesaleMinimum
        ? wholesaleMinimumQuantityMessage(minimumQuantity)
        : "Producto agregado al carrito.";
    setCartMessage(message);
    toast.success(message, { action: { label: "Ver carrito", href: "/carrito" } });
    return true;
  }, [commitCart, findProduct, priceMode, toast]);

  const updateQuantity = useCallback((productId: string, delta: number) => {
    if (!Number.isSafeInteger(delta)) return false;
    const current = cartRef.current;
    const existing = current.find((item) => item.productId === productId);
    if (!existing) return false;
    const nextQuantity = existing.quantity + delta;
    if (nextQuantity <= 0) {
      commitCart(current.filter((item) => item.productId !== productId));
      setCartMessage("Producto eliminado del carrito.");
      return true;
    }
    const result = setQuantity(productId, nextQuantity);
    if (!result.ok) toast.warning(result.message);
    return result.ok;
  }, [commitCart, setQuantity, toast]);

  const removeFromCart = useCallback((productId: string) => {
    commitCart(cartRef.current.filter((item) => item.productId !== productId));
    toast.info("Producto eliminado del carrito.");
  }, [commitCart, toast]);

  const clearInvalidCartItems = useCallback(() => {
    commitCart(
      cartRef.current.filter(
        (item) => isUuid(item.productId) && Boolean(resolvedCartProducts[item.productId]),
      ),
    );
    setCartMessage("");
    toast.info("Productos inválidos eliminados del carrito.");
  }, [commitCart, resolvedCartProducts, toast]);

  const clearCartMessage = useCallback(() => {
    setCartMessage("");
  }, []);

  const clearCart = useCallback(() => {
    commitCart([]);
    setCartMessage("");
  }, [commitCart]);

  const refreshCart = useCallback(() => {
    setResolvedCartRequestKey("");
    setCartRefreshVersion((current) => current + 1);
  }, []);

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
      addToCart,
      setQuantity,
      updateQuantity,
      removeFromCart,
      clearInvalidCartItems,
      clearCartMessage,
      clearCart,
      refreshCart,
    }),
    [
      addToCart,
      cart,
      cartCount,
      cartMessage,
      clearCart,
      clearCartMessage,
      clearInvalidCartItems,
      invalidItemCount,
      isResolvingCart,
      removeFromCart,
      refreshCart,
      rows,
      setQuantity,
      subtotal,
      tax,
      total,
      updateQuantity,
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

