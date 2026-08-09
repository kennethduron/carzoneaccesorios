import { getProductCapabilities, requireProductCapability } from "@/lib/auth/product-access";
import { getAdminProductCatalogExport } from "@/services/supabase/admin-products.service";
import { buildProductCatalogCsvResponse, buildProductCatalogExcelResponse } from "@/utils/product-catalog-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const profile = await requireProductCapability("exportProducts");
  const capabilities = getProductCapabilities(profile);
  const searchParams = new URL(request.url).searchParams;
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";

  if (format === "csv" && !capabilities.technicalExports) {
    return Response.json({ message: "No tienes permiso para exportaciones técnicas." }, { status: 403 });
  }

  const { products } = await getAdminProductCatalogExport(
    {
      query: searchParams.get("q") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      categoryId: searchParams.get("category") ?? undefined,
    },
    { includeCost: capabilities.viewCost },
  );

  return format === "csv"
    ? buildProductCatalogCsvResponse(products, capabilities.viewCost)
    : buildProductCatalogExcelResponse(products, capabilities.viewCost);
}
