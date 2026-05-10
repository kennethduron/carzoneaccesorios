"use server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CheckoutData, PriceMode } from "@/types/commerce";

type CheckoutOrderItemInput = {
  productId: string;
  quantity: number;
};

type CreateCheckoutOrderInput = {
  checkout: CheckoutData;
  items: CheckoutOrderItemInput[];
  priceMode: PriceMode;
};

type ProductForOrder = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  retail_price: number;
  wholesale_price: number;
};

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function paymentMethodValue(method: CheckoutData["paymentMethod"]) {
  if (method === "Tarjeta") {
    return "card";
  }

  if (method === "Efectivo") {
    return "cash";
  }

  return "bank_transfer";
}

function createOrderNumber() {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CZ-${Date.now().toString().slice(-8)}-${suffix}`;
}

export async function createCheckoutOrderAction(input: CreateCheckoutOrderInput) {
  const customerName = input.checkout.customerName.trim();
  const phone = input.checkout.phone.trim();
  const deliveryAddress = input.checkout.address.trim();
  const email = input.checkout.email.trim() || null;
  const paymentMethod = paymentMethodValue(input.checkout.paymentMethod);
  const bankReference = input.checkout.bankTransferReference.trim();

  if (!customerName || !phone || !deliveryAddress || input.items.length === 0) {
    return { ok: false, message: "Completa tus datos y agrega productos para crear el pedido." };
  }

  if (paymentMethod === "bank_transfer" && !bankReference) {
    return { ok: false, message: "Debes ingresar el número de referencia de la transferencia." };
  }

  const normalizedItems = input.items
    .map((item) => ({
      productId: item.productId,
      quantity: Math.trunc(Number(item.quantity)),
    }))
    .filter((item) => item.productId && item.quantity > 0);

  if (normalizedItems.length === 0) {
    return { ok: false, message: "Agrega productos válidos para crear el pedido." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const productIds = [...new Set(normalizedItems.map((item) => item.productId))];
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, sku, name, stock, retail_price, wholesale_price")
    .in("id", productIds)
    .returns<ProductForOrder[]>();

  if (productsError) {
    return { ok: false, message: productsError.message };
  }

  const productById = new Map((products ?? []).map((product) => [product.id, product]));
  const orderItems = [];

  for (const item of normalizedItems) {
    const product = productById.get(item.productId);
    if (!product) {
      return { ok: false, message: "Uno de los productos ya no está disponible." };
    }

    if (item.quantity > product.stock) {
      return { ok: false, message: `Solo hay ${product.stock} unidades disponibles de ${product.name}.` };
    }

    const unitPrice = input.priceMode === "wholesale" ? product.wholesale_price : product.retail_price;
    orderItems.push({
      product,
      quantity: item.quantity,
      unitPrice: roundCurrency(unitPrice),
      lineTotal: roundCurrency(unitPrice * item.quantity),
    });
  }

  const subtotal = roundCurrency(orderItems.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = roundCurrency(subtotal * 0.15);
  const total = roundCurrency(subtotal + tax);
  const orderId = crypto.randomUUID();
  const orderNumber = createOrderNumber();

  const { error: orderError } = await supabase.from("orders").insert({
    id: orderId,
    order_number: orderNumber,
    user_id: user?.id ?? null,
    customer_name: customerName,
    email,
    phone,
    delivery_address: deliveryAddress,
    payment_method: paymentMethod,
    price_mode: input.priceMode,
    subtotal,
    tax,
    shipping_total: 0,
    total,
    status: "pending",
  });

  if (orderError) {
    return { ok: false, message: orderError.message };
  }

  const { error: itemsError } = await supabase.from("order_items").insert(
    orderItems.map((item) => ({
      order_id: orderId,
      product_id: item.product.id,
      sku: item.product.sku,
      product_name: item.product.name,
      quantity: item.quantity,
      applied_price_mode: input.priceMode,
      unit_price: item.unitPrice,
      line_total: item.lineTotal,
      retail_price_snapshot: roundCurrency(item.product.retail_price),
      wholesale_price_snapshot: roundCurrency(item.product.wholesale_price),
    })),
  );

  if (itemsError) {
    return { ok: false, message: itemsError.message };
  }

  const { error: paymentError } = await supabase.from("payments").insert({
    order_id: orderId,
    method: paymentMethod,
    payment_method: paymentMethod,
    status: "pending",
    payment_status: "pending",
    amount: total,
    reference: paymentMethod === "bank_transfer" ? bankReference : null,
    bank_reference_number: paymentMethod === "bank_transfer" ? bankReference : null,
    provider: paymentMethod === "card" ? "pending_gateway" : null,
  });

  if (paymentError) {
    return { ok: false, message: paymentError.message };
  }

  return {
    ok: true,
    message: "Pedido creado correctamente. El admin o la contadora podrán revisarlo para facturación.",
    orderNumber,
  };
}
