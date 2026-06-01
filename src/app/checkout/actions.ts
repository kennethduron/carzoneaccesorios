"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { notifyAdminsOfNewOrder } from "@/lib/notifications/order-email";
import { checkRateLimit, getRateLimitMessage } from "@/lib/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import type { CheckoutData, PriceMode } from "@/types/commerce";
import { calculateCheckoutFees } from "@/utils/commerce-settings";
import { getAuthorizedProductPrice, hasValidWholesalePrice } from "@/utils/pricing";
import { validateHondurasPhone } from "@/utils/validation";

type CheckoutOrderItemInput = {
  productId: string;
  quantity: number;
};

type CreateCheckoutOrderInput = {
  checkout: CheckoutData;
  items: CheckoutOrderItemInput[];
  priceMode: PriceMode;
};

type CheckoutActionResult = {
  ok: boolean;
  message: string;
  orderNumber?: string;
  trackingCode?: string;
  transferReceiptUrl?: string | null;
};

type TransferReceiptUpload = {
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string | null;
  originalFilename: string | null;
};

export type WholesalePurchaseStatusResult = {
  ok: boolean;
  isFirstWholesalePurchase: boolean;
  message?: string;
};

export type CheckoutAccountInfo = {
  isAuthenticated: boolean;
  email: string | null;
  customerName: string | null;
  phone: string | null;
  rtn: string | null;
  address: string | null;
  city: string | null;
};

type CustomerAuthorizationRow = {
  id: string;
  is_wholesale: boolean;
  wholesale_status: "none" | "pending" | "approved" | "rejected" | "suspended" | null;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
};

type CheckoutProductPriceRow = {
  id: string;
  name: string;
  retail_price: number | null;
  wholesale_price: number | null;
  wholesale_min_quantity: number | null;
};

const wholesaleMessages = {
  loginRequired: "Inicia sesión con tu cuenta mayorista aprobada para activar precios.",
  accountNotAuthorized: "Tu cuenta no está autorizada para compras mayoristas.",
};
const hondurasOnlyMessage = "Actualmente solo realizamos entregas dentro de Honduras.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bankReferencePattern = /^[A-Za-z0-9 -]+$/;

function isUuid(value: string) {
  return uuidPattern.test(value);
}

function safeCheckoutErrorMessage(message: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("solo hay") ||
    normalized.includes("stock") ||
    normalized.includes("inventario") ||
    normalized.includes("ya no esta disponible") ||
    normalized.includes("ya no está disponible") ||
    normalized.includes("no tiene stock suficiente")
  ) {
    return "La cantidad solicitada ya no está disponible. Este producto fue tomado por otro cliente; actualiza tu carrito para continuar.";
  }

  if (normalized.includes("invalid input syntax for type uuid")) {
    return "Hay un producto inválido en el carrito. Elimínalo y vuelve a intentar.";
  }

  if (normalized.includes("row-level security") || normalized.includes("permission denied") || normalized.includes("rls")) {
    return "No tienes permiso para realizar esta acción.";
  }

  if (normalized.includes("duplicate key") || normalized.includes("unique constraint")) {
    return "Ya existe un registro con esos datos. Revisa la información e intenta nuevamente.";
  }

  if (
    normalized.includes("primera compra mayorista") ||
    normalized.includes("minimo requerido") ||
    normalized.includes("compra minima") ||
    normalized.includes("compra mínima") ||
    normalized.includes("cantidad minima mayorista") ||
    normalized.includes("cantidad mínima mayorista")
  ) {
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

function formatMoney(value: number) {
  return `L ${Number(value || 0).toLocaleString("es-HN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseCheckoutOrderInput(formData: FormData): CreateCheckoutOrderInput {
  return {
    checkout: JSON.parse(String(formData.get("checkout") ?? "{}")) as CheckoutData,
    items: JSON.parse(String(formData.get("items") ?? "[]")) as CheckoutOrderItemInput[],
    priceMode: String(formData.get("priceMode") ?? "retail") as PriceMode,
  };
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function validateBankReference(value: string) {
  const reference = value.trim().replace(/\s+/g, " ");

  if (!reference) {
    return { ok: false as const, message: "Ingresa el número de referencia bancaria." };
  }

  if (reference.length < 4) {
    return { ok: false as const, message: "La referencia bancaria debe tener al menos 4 caracteres." };
  }

  if (reference.length > 80) {
    return { ok: false as const, message: "La referencia bancaria no debe superar 80 caracteres." };
  }

  if (!bankReferencePattern.test(reference)) {
    return { ok: false as const, message: "La referencia bancaria solo puede incluir letras, números, espacios y guiones." };
  }

  return { ok: true as const, value: reference };
}

export async function getCheckoutAccountAction(): Promise<CheckoutAccountInfo> {
  const guestAccount: CheckoutAccountInfo = {
    isAuthenticated: false,
    email: null,
    customerName: null,
    phone: null,
    rtn: null,
    address: null,
    city: null,
  };

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return guestAccount;
  }

  const admin = getSupabaseAdminClient();
  const [{ data: profile }, { data: customer }] = await Promise.all([
    admin
      .from("users")
      .select("email, full_name, phone")
      .eq("id", user.id)
      .maybeSingle<{ email: string | null; full_name: string | null; phone: string | null }>(),
    admin
      .from("customers")
      .select("contact_name, email, phone, tax_id, address, city")
      .eq("user_id", user.id)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<{
        contact_name: string | null;
        email: string | null;
        phone: string | null;
        tax_id: string | null;
        address: string | null;
        city: string | null;
      }>(),
  ]);

  const accountEmail = normalizeEmail(user.email || profile?.email || customer?.email);

  return {
    isAuthenticated: true,
    email: accountEmail || null,
    customerName: customer?.contact_name || profile?.full_name || null,
    phone: customer?.phone || profile?.phone || null,
    rtn: customer?.tax_id || null,
    address: customer?.address || null,
    city: customer?.city || null,
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
    .eq("wholesale_status", "approved")
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

async function uploadTransferReceipt(file: File | null, bankReference: string): Promise<TransferReceiptUpload | null> {
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
  const publicId = `${bankReference.replace(/[^a-z0-9]/gi, "-").slice(0, 40) || "transferencia"}-${randomUUID()}`;

  return new Promise<TransferReceiptUpload>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/comprobantes-transferencia-privados",
        public_id: publicId,
        resource_type: "auto",
        type: "authenticated",
        overwrite: false,
        use_filename: false,
        unique_filename: false,
        context: {
          source: "checkout_bank_transfer",
        },
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.public_id) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida para el comprobante."));
          return;
        }

        resolve({
          publicId: uploadResult.public_id,
          resourceType: uploadResult.resource_type ?? (isPdf ? "raw" : "image"),
          deliveryType: uploadResult.type ?? "authenticated",
          format: uploadResult.format ?? extension,
          originalFilename: file.name.slice(0, 180),
        });
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

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const accountEmail = normalizeEmail(user?.email);
  const submittedEmail = normalizeEmail(input.checkout.email);

  const checkoutLimit = await checkRateLimit({
    route: "/checkout",
    limit: 6,
    windowSeconds: 10 * 60,
    key: user?.id ? `user:${user.id}` : submittedEmail || String(input.checkout.phone || "").trim().toLowerCase(),
  });

  if (!checkoutLimit.ok) {
    return { ok: false, message: getRateLimitMessage(checkoutLimit.retryAfter) };
  }

  const customerName = String(input.checkout.customerName ?? "").trim();
  const country = String(input.checkout.country ?? "").trim();
  const department = String(input.checkout.department ?? "").trim();
  const city = String(input.checkout.city ?? "").trim();
  const phoneResult = validateHondurasPhone(input.checkout.phone);
  const customerRtn = String(input.checkout.rtn ?? "").trim() || null;
  const deliveryAddress = String(input.checkout.address ?? "").trim();
  const email = user ? accountEmail : submittedEmail;
  const paymentMethod = paymentMethodValue(input.checkout.paymentMethod);
  const paymentTiming =
    paymentMethod === "cash"
      ? "on_delivery"
      : paymentMethod === "card"
        ? "before_delivery"
        : input.checkout.paymentTiming === "on_delivery"
          ? "on_delivery"
          : "before_delivery";
  const bankReferenceResult =
    paymentMethod === "bank_transfer" && paymentTiming === "before_delivery"
      ? validateBankReference(String(input.checkout.bankTransferReference ?? ""))
      : { ok: true as const, value: "" };
  const bankReference = bankReferenceResult.ok ? bankReferenceResult.value : "";
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const settings = await getPublicCompanySettings();

  if (country !== "Honduras") {
    return { ok: false, message: hondurasOnlyMessage };
  }

  if (!phoneResult.ok) {
    return { ok: false, message: phoneResult.message };
  }

  const phone = phoneResult.value;

  if (user && !email) {
    return { ok: false, message: "No pudimos validar el correo de tu cuenta. Cierra sesión e inicia sesión nuevamente." };
  }

  if (!user && (!email || !emailPattern.test(email))) {
    return { ok: false, message: "Ingresa un correo válido para el pedido." };
  }

  if (!customerName || !department || !city || !deliveryAddress || rawItems.length === 0) {
    return { ok: false, message: "Completa tus datos y agrega productos para crear el pedido." };
  }

  if (paymentMethod === "bank_transfer" && !settings.allow_bank_transfer) {
    return { ok: false, message: "La transferencia bancaria no está disponible en este momento." };
  }

  if (paymentMethod === "cash" && !settings.allow_cash_on_delivery) {
    return { ok: false, message: "El pago contra entrega no está disponible en este momento." };
  }

  if (paymentMethod === "card" && settings.bac_card_status !== "active") {
    return { ok: false, message: "El pago con tarjeta no está disponible hasta activar la pasarela BAC." };
  }

  if (!bankReferenceResult.ok) {
    return { ok: false, message: bankReferenceResult.message };
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

  const productIds = Array.from(new Set(normalizedItems.map((item) => item.productId)));
  const { data: availableProducts, error: productsError } = await supabase
    .from("products")
    .select("id, name, retail_price, wholesale_price, wholesale_min_quantity")
    .in("id", productIds)
    .eq("active", true)
    .eq("status", "active")
    .returns<CheckoutProductPriceRow[]>();

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
    if (!settings.wholesale_purchases_enabled) {
      return { ok: false, message: "Las compras mayoristas están desactivadas temporalmente." };
    }

    if (!user) {
      return { ok: false, message: wholesaleMessages.loginRequired };
    }

    const { data: customerRows, error: customerError } = await supabase
      .from("customers")
      .select("id, is_wholesale, wholesale_status, status, active")
      .eq("user_id", user.id)
      .returns<CustomerAuthorizationRow[]>();

    if (customerError) {
      return { ok: false, message: wholesaleMessages.accountNotAuthorized };
    }

    const authorizedWholesaleAccount = (customerRows ?? []).find(
      (customer) =>
        customer.active &&
        (customer.wholesale_status === "approved" ||
          (customer.wholesale_status === null && customer.is_wholesale && customer.status === "active")),
    );

    if (!authorizedWholesaleAccount) {
      return { ok: false, message: wholesaleMessages.accountNotAuthorized };
    }

    const wholesaleQuantityIssues = normalizedItems
      .map((item) => {
        const product = (availableProducts ?? []).find((entry) => entry.id === item.productId);
        const minimumQuantity = Math.max(1, Math.trunc(Number(product?.wholesale_min_quantity ?? 1)));

        if (
          !product ||
          minimumQuantity <= 1 ||
          !hasValidWholesalePrice({
            retail_price: Number(product.retail_price ?? 0),
            wholesale_price: Number(product.wholesale_price ?? 0),
          }) ||
          item.quantity >= minimumQuantity
        ) {
          return null;
        }

        return {
          name: product.name,
          quantity: item.quantity,
          minimumQuantity,
        };
      })
      .filter(Boolean) as Array<{ name: string; quantity: number; minimumQuantity: number }>;

    if (wholesaleQuantityIssues.length > 0) {
      const detail = wholesaleQuantityIssues
        .map((item) => `${item.name} requiere mínimo ${item.minimumQuantity} unidades; tienes ${item.quantity}`)
        .join("; ");
      return {
        ok: false,
        message:
          wholesaleQuantityIssues.length === 1
            ? `No se puede crear el pedido. El producto ${wholesaleQuantityIssues[0].name} requiere mínimo ${wholesaleQuantityIssues[0].minimumQuantity} unidades para compra mayorista.`
            : `No se puede crear el pedido. Corrige las cantidades mínimas mayoristas antes de crear el pedido: ${detail}.`,
      };
    }

    if (settings.first_wholesale_minimum > 0) {
      const { data: hasCompletedWholesaleOrder, error: historyError } = await supabase.rpc("has_completed_wholesale_order", {
        target_customer_id: authorizedWholesaleAccount.id,
      });

      if (historyError) {
        return { ok: false, message: "No se pudo validar historial mayorista." };
      }

      if (!Boolean(hasCompletedWholesaleOrder)) {
        const authorizedPriceByProductId = new Map(
          (availableProducts ?? []).map((product) => [
            product.id,
            getAuthorizedProductPrice(
              { retail_price: Number(product.retail_price ?? 0), wholesale_price: Number(product.wholesale_price ?? 0) },
              "wholesale",
            ),
          ]),
        );
        const wholesaleSubtotal = normalizedItems.reduce(
          (total, item) => total + (authorizedPriceByProductId.get(item.productId) ?? 0) * item.quantity,
          0,
        );
        const wholesaleTax = roundMoney(wholesaleSubtotal * Number(settings.tax_rate ?? 0.15));
        const checkoutFees = calculateCheckoutFees({ subtotal: wholesaleSubtotal, paymentMethod, paymentTiming, settings });
        const wholesaleFinalTotal = roundMoney(wholesaleSubtotal + wholesaleTax + checkoutFees.shippingFee + checkoutFees.cashOnDeliveryFee);
        const missing = Math.max(0, roundMoney(settings.first_wholesale_minimum - wholesaleFinalTotal));

        if (missing > 0) {
          return {
            ok: false,
            message: `Tu primera compra mayorista debe alcanzar un total final de ${formatMoney(settings.first_wholesale_minimum)} o más. Te faltan ${formatMoney(missing)} para completar el mínimo de primera compra mayorista.`,
          };
        }
      }
    }
  }

  let transferReceipt: TransferReceiptUpload | null = null;

  try {
    const receiptFile = formData.get("transferReceipt");
    transferReceipt =
      paymentMethod === "bank_transfer" && paymentTiming === "before_delivery" && receiptFile instanceof File
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
    .rpc("create_checkout_order_v2", {
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
      requested_payment_timing: paymentTiming,
      bank_reference_number: paymentMethod === "bank_transfer" && paymentTiming === "before_delivery" ? bankReference : null,
      order_items: normalizedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
      })),
      wholesale_code: null,
      wholesale_code_id: null,
      transfer_receipt_url: null,
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
        payment_timing: paymentTiming,
      },
    });

    return { ok: false, message: safeCheckoutErrorMessage(error.message) };
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ order_id: string; order_number: string; tracking_code: string }>;
  const createdOrder = rows[0];

  if (!createdOrder) {
    return { ok: false, message: "No se pudo crear el pedido." };
  }

  if (transferReceipt) {
    const admin = getSupabaseAdminClient();
    const { error: receiptMetadataError } = await admin
      .from("payments")
      .update({
        transfer_receipt_url: null,
        transfer_receipt_public_id: transferReceipt.publicId,
        transfer_receipt_resource_type: transferReceipt.resourceType,
        transfer_receipt_delivery_type: transferReceipt.deliveryType,
        transfer_receipt_format: transferReceipt.format,
        transfer_receipt_original_filename: transferReceipt.originalFilename,
        transfer_receipt_uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", createdOrder.order_id);

    if (receiptMetadataError) {
      await writeErrorLog({
        route: "/checkout",
        action: "checkout.transfer_receipt_metadata_failed",
        errorMessage: receiptMetadataError.message,
        metadata: {
          order_id: createdOrder.order_id,
          receipt_public_id_present: Boolean(transferReceipt.publicId),
        },
      });
    }
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
    message: "Pedido creado correctamente. Nuestro equipo revisará el pago y la facturación.",
    orderNumber: createdOrder.order_number,
    trackingCode: createdOrder.tracking_code,
    transferReceiptUrl: null,
  };
}

