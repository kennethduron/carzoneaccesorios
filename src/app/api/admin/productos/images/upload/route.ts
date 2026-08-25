import { randomUUID } from "node:crypto";
import { getProductCapabilities } from "@/lib/auth/product-access";
import { getSessionProfile } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import {
  createProductImageUploadRouteHandler,
  type ProductImageUploadRouteDependencies,
} from "@/lib/product-image-upload-route-handler";
import { uploadProductImageToCloudinary } from "@/services/product-image-upload.service";
import type { AuthProfile } from "@/types/auth";

export const runtime = "nodejs";

const dependencies: ProductImageUploadRouteDependencies = {
  createCorrelationId: randomUUID,
  getSessionProfile,
  canManageImages: (profile) => getProductCapabilities(profile as AuthProfile).manageImages,
  uploadImage: uploadProductImageToCloudinary,
  logFailure: async (failure) => {
    await writeErrorLog({
      route: "/api/admin/productos/images/upload",
      module: "products",
      category: "system",
      action: "products.image_http_upload_failed",
      errorMessage: failure.code,
      errorCode: failure.code,
      httpStatus: failure.status,
      customerMessage: "La imagen no pudo cargarse; el archivo permanece disponible para reintentar.",
      userId: failure.userId,
      metadata: {
        correlation_id: failure.correlationId,
        request_id: failure.requestId,
        stage: failure.stage,
        file_size: failure.fileSize,
        mime_type: failure.mimeType,
      },
    });
  },
};

const handleUpload = createProductImageUploadRouteHandler(dependencies);

export async function POST(request: Request) {
  return handleUpload(request);
}
