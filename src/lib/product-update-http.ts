import type { ProductFormInput } from "@/types/products";

export type ProductUpdateApiResponse =
  | {
      ok: true;
      code: "PRODUCT_UPDATED" | "PRODUCT_SAVED_REFRESH_PENDING" | "PRODUCT_SAVED_POST_SAVE_WARNING";
      message: string;
      productId: string;
      slug: string;
      correlationId: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      correlationId: string;
      stage?: "authorization" | "validation" | "database_write";
    };

export const productUpdateRequestTimeoutMs = 30_000;

export async function updateProductViaHttpApi(
  product: ProductFormInput & { id: string },
  requestId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProductUpdateApiResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? productUpdateRequestTimeoutMs);

  try {
    const response = await fetchImpl("/api/admin/productos/update", {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
      },
      body: JSON.stringify({ requestId, product }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null) as ProductUpdateApiResponse | null;
    if (
      !result
      || typeof result.ok !== "boolean"
      || typeof result.code !== "string"
      || typeof result.message !== "string"
      || result.correlationId !== requestId
      || (result.ok && (
        typeof result.productId !== "string"
        || result.productId !== product.id
        || typeof result.slug !== "string"
        || !["PRODUCT_UPDATED", "PRODUCT_SAVED_REFRESH_PENDING", "PRODUCT_SAVED_POST_SAVE_WARNING"].includes(result.code)
      ))
    ) {
      throw new Error("INVALID_PRODUCT_UPDATE_RESPONSE");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
