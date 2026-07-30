import "server-only";

import { configureCloudinary } from "@/lib/cloudinary";

export type SupplierPaymentReceiptUpload = {
  publicId: string;
  resourceType: "image" | "raw";
  created: boolean;
};

const receiptFolder = "car-zone/comprobantes-proveedor-privados";

export async function uploadSupplierPaymentReceipt(
  file: File | null,
  requestKey: string,
): Promise<SupplierPaymentReceiptUpload | null> {
  if (!file || file.size === 0) {
    return null;
  }

  const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
  const isPdf = file.type === "application/pdf";
  if (!isImage && !isPdf) {
    throw new Error("El comprobante debe ser JPG, PNG, WEBP o PDF.");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("El comprobante no puede superar 8 MB.");
  }

  const publicId = `${receiptFolder}/${requestKey}`;
  const resourceType = isPdf ? "raw" : "image";
  const cloudinary = configureCloudinary();

  try {
    await cloudinary.api.resource(publicId, {
      resource_type: resourceType,
      type: "authenticated",
    });
    return { publicId, resourceType, created: false };
  } catch {
    // The deterministic asset does not exist yet. Upload it once.
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return new Promise<SupplierPaymentReceiptUpload>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: resourceType,
        type: "authenticated",
        overwrite: false,
        use_filename: false,
        unique_filename: false,
        context: {
          source: "supplier_multi_payment_v1",
          request_key_suffix: requestKey.slice(-8),
        },
      },
      (error, result) => {
        if (error || !result?.public_id) {
          reject(new Error("No se pudo guardar el comprobante privado."));
          return;
        }
        resolve({ publicId: result.public_id, resourceType, created: true });
      },
    );
    stream.end(buffer);
  });
}

export async function removeSupplierPaymentReceipt(
  upload: SupplierPaymentReceiptUpload | null,
) {
  if (!upload?.created) {
    return;
  }
  const cloudinary = configureCloudinary();
  await cloudinary.uploader.destroy(upload.publicId, {
    resource_type: upload.resourceType,
    type: "authenticated",
    invalidate: true,
  });
}
