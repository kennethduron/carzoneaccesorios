"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { notifyAdminsOfNewOrder } from "@/lib/notifications/order-email";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CheckoutData, PriceMode } from "@/types/commerce";
import { validateHondurasPhone } from "@/utils/validation";

type CheckoutOrderItemInput = {
  productId: string;
  quantity: number;
};

type CreateCheckoutOrderInput = {
  checkout: CheckoutData;
  items: CheckoutOrderItemInput[];
  priceMode: PriceMode;
  wholesaleCode?: string | null;
  wholesaleCodeId?: string | null;
};

type CheckoutActionResult = {
  ok: boolean;
  message: string;
  orderNumber?: string;
  trackingCode?: string;
  transferReceiptUrl?: string | null;
};

export type WholesalePurchaseStatusResult = {
  ok: boolean;
  isFirstWholesalePurchase: boolean;
  message?: string;
};

type WholesaleCodeActivationRow = {
  id: string;
};

type WholesaleCodePublicRow = {
  is_valid: boolean;
};

type CustomerAuthorizationRow = {
  id: string;
  is_wholesale: boolean;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
};

const wholesaleMessages = {
  invalidCode: "Código mayorista inválido.",
  loginRequired: "Código válido. Inicia sesión con tu cuenta mayorista para activar precios.",
  codeNotOwned: "Este código mayorista no pertenece a tu cuenta.",
  accountNotAuthorized: "Tu cuenta no está autorizada para compras mayoristas.",
};
const hondurasOnlyMessage = "Actualmente solo realizamos entregas dentro de Honduras.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return uuidPattern.test(value);
}

function safeCheckoutErrorMessage(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("invalid input syntax for type uuid")) {
    return "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.";
  }

  if (normalized.includes("row-level security") || normalized.includes("permission denied") || normalized.includes("rls")) {
    return "No tienes permiso para realizar esta acción.";
  }

  if (normalized.includes("duplicate key") || normalized.includes("unique constraint")) {
    return "Ya existe un registro con esos datos. Revisa la información e intenta nuevamente.";
  }

  if (normalized.includes("primera compra mayorista") || normalized.includes("minimo requerido")) {
    return message;
  }

  if (normalized.includes("checkout") || normalized.includes("products") || normalized.includes("uuid") || normalized.includes("rpc")) {
    return "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente.";
  }

  return message || "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente.";
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

function parseCheckoutOrderInput(formData: FormData): CreateCheckoutOrderInput {
  return {
    checkout: JSON.parse(String(formData.get("checkout") ?? "{}")) as CheckoutData,
    items: JSON.parse(String(formData.get("items") ?? "[]")) as CheckoutOrderItemInput[],
    priceMode: String(formData.get("priceMode") ?? "retail") as PriceMode,
    wholesaleCode: String(formData.get("wholesaleCode") ?? "").trim() || null,
    wholesaleCodeId: String(formData.get("wholesaleCodeId") ?? "").trim() || null,
  };
}

export async function getWholesalePurchaseStatusAction(customerId: string | null): Promise<WholesalePurchaseStatusResult> {
  if (!customerId || !isUuid(customerId)) {
    return { ok: false, isFirstWholesalePurchase: true, message: "Cuenta mayorista no valida." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, isFirstWholesalePurchase: true, message: wholesaleMessages.loginRequired };
  }

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("user_id", user.id)
    .eq("is_wholesale", true)
    .eq("active", true)
    .maybeSingle<{ id: string }>();

  if (customerError || !customer) {
    return { ok: false, isFirstWholesalePurchase: true, message: wholesaleMessages.accountNotAuthorized };
  }

  const { data, error } = await supabase.rpc("has_completed_wholesale_order", { target_customer_id: customerId });

  if (error) {
    return { ok: false, isFirstWholesalePurchase: true, message: "No se pudo validar historial mayorista." };
  }

  return { ok: true, isFirstWholesalePurchase: !Boolean(data) };
}

async function uploadTransferReceipt(file: File | null, bankReference: string) {
  if (!file || file.size === 0) {
    return null;
  }

  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";

  if (!isImage && !isPdf) {
    throw new Error("Solo se permiten comprobantes en imagen o PDF.");
  }

  if (file.size > 8 * 1024 * 1024) {
    throw new Error("El comprobante no puede superar 8 MB.");
  }

  const cloudinary = configureCloudinary();
  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "archivo";
  const publicId = `${bankReference.replace(/[^a-z0-9]/gi, "-").slice(0, 40) || "transferencia"}-${randomUUID()}.${extension}`;

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/comprobantes-transferencia",
        public_id: publicId,
        resource_type: "auto",
        overwrite: false,
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.secure_url) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida para el comprobante."));
          return;
        }

        resolve(uploadResult.secure_url);
      },
    );

    stream.end(buffer);
  });
}

export async function createCheckoutOrderAction(formData: FormData): Promise<CheckoutActionResult> {
  let input: CreateCheckoutOrderInput;

  try {
    input = parseCheckoutOrderInput(formData);
  } catch {
    return { ok: false, message: "No se pudo leer la información del checkout." };
  }

  const customerName = String(input.checkout.customerName ?? "").trim();
  const country = String(input.checkout.country ?? "").trim();
  const department = String(input.checkout.department ?? "").trim();
  const city = String(input.checkout.city ?? "").trim();
  const phoneResult = validateHondurasPhone(input.checkout.phone);
  const customerRtn = String(input.checkout.rtn ?? "").trim() || null;
  const deliveryAddress = String(input.checkout.address ?? "").trim();
  const email = String(input.checkout.email ?? "").trim() || null;
  const paymentMethod = paymentMethodValue(input.checkout.paymentMethod);
  const bankReference = String(input.checkout.bankTransferReference ?? "").trim();
  const rawItems = Array.isArray(input.items) ? input.items : [];

  if (country !== "Honduras") {
    return { ok: false, message: hondurasOnlyMessage };
  }

  if (!phoneResult.ok) {
    return { ok: false, message: phoneResult.message };
  }

  const phone = phoneResult.value;

  if (!customerName || !department || !city || !deliveryAddress || rawItems.length === 0) {
    return { ok: false, message: "Completa tus datos y agrega productos para crear el pedido." };
  }

  if (paymentMethod === "bank_transfer" && !bankReference) {
    return { ok: false, message: "Debes ingresar el número de referencia de la transferencia." };
  }

  if (input.priceMode === "wholesale" && (!input.wholesaleCode?.trim() || !input.wholesaleCodeId?.trim())) {
    return { ok: false, message: wholesaleMessages.invalidCode };
  }

  const normalizedItems = rawItems
    .map((item) => ({
      productId: item.productId,
      quantity: Math.trunc(Number(item.quantity)),
    }))
    .filter((item) => item.productId && item.quantity > 0);

  if (normalizedItems.length === 0) {
    return { ok: false, message: "Agrega productos validos para crear el pedido." };
  }

  if (normalizedItems.some((item) => !isUuid(item.productId))) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.invalid_product_id",
      errorMessage: "Checkout received a non-UUID product id.",
      metadata: {
        product_ids: normalizedItems.map((item) => item.productId),
      },
    });

    return {
      ok: false,
      message: "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.",
    };
  }

  const supabase = await getSupabaseServerClient();

  const productIds = Array.from(new Set(normalizedItems.map((item) => item.productId)));
  const { data: availableProducts, error: productsError } = await supabase
    .from("products")
    .select("id")
    .in("id", productIds)
    .eq("active", true)
    .eq("status", "active")
    .returns<Array<{ id: string }>>();

  if (productsError) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.product_validation_failed",
      errorMessage: productsError.message,
      metadata: {
        product_ids: productIds,
      },
    });

    return { ok: false, message: "No pudimos procesar tu pedido. Revisa los productos del carrito e intenta nuevamente." };
  }

  const availableProductIds = new Set((availableProducts ?? []).map((product) => product.id));
  if (productIds.some((productId) => !availableProductIds.has(productId))) {
    return {
      ok: false,
      message: "Uno de los productos de tu carrito ya no está disponible. Elimínalo y vuelve a intentar.",
    };
  }

  if (input.priceMode === "wholesale") {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { ok: false, message: wholesaleMessages.loginRequired };
    }

    const { data: publicValidationData } = await supabase
      .rpc("validate_wholesale_code_public", { raw_code: input.wholesaleCode?.trim().toUpperCase() || "" })
      .returns<WholesaleCodePublicRow[]>();

    const publicValidationRows = Array.isArray(publicValidationData) ? publicValidationData : [];
    if (!publicValidationRows[0]?.is_valid) {
      return { ok: false, message: wholesaleMessages.invalidCode };
    }

    const { data: activatedData, error: activationError } = await supabase
      .rpc("activate_wholesale_account", { raw_code: input.wholesaleCode?.trim().toUpperCase() || "" })
      .returns<WholesaleCodeActivationRow[]>();

    if (activationError) {
      return { ok: false, message: wholesaleMessages.accountNotAuthorized };
    }

    const activatedRows = Array.isArray(activatedData) ? activatedData : [];
    if (!activatedRows.some((row) => row.id === input.wholesaleCodeId)) {
      const { data: customerRows } = await supabase
        .from("customers")
        .select("id, is_wholesale, status, active")
        .eq("user_id", user.id)
        .returns<CustomerAuthorizationRow[]>();

      const hasAuthorizedWholesaleAccount = (customerRows ?? []).some(
        (customer) => customer.is_wholesale && customer.active && customer.status === "active",
      );

      return {
        ok: false,
        message: hasAuthorizedWholesaleAccount ? wholesaleMessages.codeNotOwned : wholesaleMessages.accountNotAuthorized,
      };
    }
  }

  let transferReceiptUrl: string | null = null;

  try {
    const receiptFile = formData.get("transferReceipt");
    transferReceiptUrl =
      paymentMethod === "bank_transfer" && receiptFile instanceof File
        ? await uploadTransferReceipt(receiptFile, bankReference)
        : null;
  } catch (error) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.transfer_receipt_upload_failed",
      errorMessage: error instanceof Error ? error.message : "Transfer receipt upload failed.",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        payment_method: paymentMethod,
        bank_reference: bankReference,
      },
    });

    return {
      ok: false,
      message:
        error instanceof Error && (error.message.includes("imagen") || error.message.includes("8 MB"))
          ? error.message
          : "No se pudo subir el comprobante de transferencia. Revisa el archivo e intenta nuevamente.",
    };
  }

  const { data, error } = await supabase
    .rpc("create_checkout_order", {
      customer_name: customerName,
      customer_email: email,
      customer_phone: phone,
      customer_rtn: customerRtn,
      delivery_address: deliveryAddress,
      delivery_country: "Honduras",
      country_code: "HN",
      delivery_department: department,
      delivery_city: city,
      requested_price_mode: input.priceMode,
      requested_payment_method: paymentMethod,
      bank_reference_number: paymentMethod === "bank_transfer" ? bankReference : null,
      order_items: normalizedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      wholesale_code: input.wholesaleCode?.trim().toUpperCase() || null,
      wholesale_code_id: input.wholesaleCodeId || null,
      transfer_receipt_url: transferReceiptUrl,
    })
    .returns<Array<{ order_id: string; order_number: string; tracking_code: string }>>();

  if (error) {
    await writeErrorLog({
      route: "/checkout",
      action: "checkout.create_order_failed",
      errorMessage: error.message,
      metadata: {
        code: error.code,
        details: error.details,
        hint: error.hint,
        product_ids: productIds,
        price_mode: input.priceMode,
        payment_method: paymentMethod,
      },
    });

    return { ok: false, message: safeCheckoutErrorMessage(error.message) };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ order_id: string; order_number: string; tracking_code: string }>;
  const createdOrder = rows[0];

  if (!createdOrder) {
    return { ok: false, message: "No se pudo crear el pedido." };
  }

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/reportes");
  revalidatePath("/catalogo");

  try {
    await notifyAdminsOfNewOrder({
      orderId: createdOrder.order_id,
      orderNumber: createdOrder.order_number,
      trackingCode: createdOrder.tracking_code,
    });
  } catch (notificationError) {
    await writeErrorLog({
      route: "/checkout",
      action: "notifications.order_created_unhandled",
      errorMessage: notificationError instanceof Error ? notificationError.message : "Unhandled order notification error.",
      errorStack: notificationError instanceof Error ? notificationError.stack : null,
      metadata: {
        order_id: createdOrder.order_id,
        order_number: createdOrder.order_number,
      },
    });
  }

  return {
    ok: true,
    message: "Pedido creado correctamente. El admin o la contadora podrán revisarlo para facturación.",
    orderNumber: createdOrder.order_number,
    trackingCode: createdOrder.tracking_code,
    transferReceiptUrl,
  };
}

