import type { ProductFormInput } from "@/types/products";

export type ProductCreateApiResponse =
  | {
      ok: true;
      code: "PRODUCT_CREATED" | "PRODUCT_SAVED_REFRESH_PENDING" | "PRODUCT_SAVED_POST_SAVE_WARNING";
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

export const productCreateRequestTimeoutMs = 30_000;

export async function createProductViaHttpApi(
  product: ProductFormInput,
  requestId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProductCreateApiResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? productCreateRequestTimeoutMs);

  try {
    const response = await fetchImpl("/api/admin/productos/create", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
      },
      body: JSON.stringify({ requestId, product }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null) as ProductCreateApiResponse | null;
    if (
      !result
      || typeof result.ok !== "boolean"
      || typeof result.code !== "string"
      || typeof result.message !== "string"
      || result.correlationId !== requestId
      || (result.ok && (typeof result.productId !== "string" || typeof result.slug !== "string"))
    ) {
      throw new Error("INVALID_PRODUCT_CREATE_RESPONSE");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
