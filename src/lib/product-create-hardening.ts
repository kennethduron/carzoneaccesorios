export type ProductPostSaveStage = "asset_cleanup" | "audit" | "cache_revalidation";

export type ProductCanonicalIdentity = {
  id: string;
  sku: string;
  slug: string;
};

export type ProductCreateConfirmation =
  | { status: "confirmed"; productId: string }
  | { status: "not_found" }
  | { status: "conflict" };

export type ProductCreateConfirmationResponse =
  | {
      ok: true;
      code: "PRODUCT_CREATED_CONFIRMED";
      message: string;
      productId: string;
      correlationId: string;
    }
  | {
      ok: false;
      code:
        | "AUTHENTICATION_REQUIRED"
        | "PERMISSION_DENIED"
        | "VALIDATION_FAILED"
        | "PRODUCT_NOT_CREATED"
        | "PRODUCT_CONFIRMATION_CONFLICT"
        | "PRODUCT_WRITE_UNCONFIRMED";
      message: string;
      correlationId: string;
    };

type ProductCreateActionOutcome = {
  ok: boolean;
  code: string;
  message: string;
};

export function canonicalProductCreateIdentity(input: { sku: string; slug: string; name: string }) {
  const sku = input.sku.trim().toUpperCase();
  const explicitSlug = input.slug.trim();
  const slug = explicitSlug || `${sku}-${input.name.trim()}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return { sku, slug };
}

type ProductPostSaveTask = {
  stage: ProductPostSaveStage;
  run: () => Promise<void> | void;
  onFailure: (error: unknown) => Promise<void> | void;
};

export async function runProductPostSaveTasks(tasks: ProductPostSaveTask[]) {
  const failedStages: ProductPostSaveStage[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      failedStages.push(task.stage);
      try {
        await task.onFailure(error);
      } catch {
        // A diagnostic failure must not reverse or misreport a committed save.
      }
    }
  }
  return { failedStages };
}

export function classifyProductCreateConfirmation(
  productsBySku: ProductCanonicalIdentity[],
  productsBySlug: ProductCanonicalIdentity[],
): ProductCreateConfirmation {
  if (productsBySku.length === 0 && productsBySlug.length === 0) {
    return { status: "not_found" };
  }

  if (
    productsBySku.length === 1
    && productsBySlug.length === 1
    && productsBySku[0].id === productsBySlug[0].id
    && productsBySku[0].sku === productsBySlug[0].sku
    && productsBySku[0].slug === productsBySlug[0].slug
  ) {
    return { status: "confirmed", productId: productsBySku[0].id };
  }

  return { status: "conflict" };
}

export async function runProductCreateWithConfirmation<
  TSave extends ProductCreateActionOutcome,
  TConfirmation extends ProductCreateActionOutcome,
>(
  save: () => Promise<TSave>,
  confirm: () => Promise<TConfirmation>,
): Promise<TSave | TConfirmation> {
  try {
    const result = await save();
    if (!result.ok && result.code === "PRODUCT_WRITE_UNCONFIRMED") {
      return await confirm();
    }
    return result;
  } catch {
    return await confirm();
  }
}

export function createProductSaveSingleFlightGuard() {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    finish() {
      active = false;
    },
  };
}
