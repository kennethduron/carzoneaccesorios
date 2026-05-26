import { NextResponse, type NextRequest } from "next/server";
import { configureCloudinary } from "@/lib/cloudinary";
import { logCronRun, verifyCronRequest } from "@/lib/cron";
import { getSupabaseAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type BannerMediaRow = {
  id: string;
  media_url: string | null;
  media_public_id: string | null;
  media_resource_type: "image" | "video" | null;
};

async function runCleanup(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);

  if (unauthorized) {
    return unauthorized;
  }

  const startedAt = Date.now();

  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin
      .from("holiday_banners")
      .select("id, media_url, media_public_id, media_resource_type")
      .returns<BannerMediaRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    const publicIds = new Set((data ?? []).map((banner) => banner.media_public_id).filter(Boolean));
    const invalidRecords = (data ?? []).filter((banner) => !banner.media_url || !banner.media_public_id || !banner.media_resource_type).length;
    const cloudinary = configureCloudinary();
    const [images, videos] = await Promise.all([
      cloudinary.api.resources({ resource_type: "image", type: "upload", prefix: "car-zone/banners", max_results: 500 }),
      cloudinary.api.resources({ resource_type: "video", type: "upload", prefix: "car-zone/banners", max_results: 500 }),
    ]);

    const resources = [
      ...((images as { resources?: Array<{ public_id: string }> }).resources ?? []).map((resource) => ({ ...resource, resource_type: "image" as const })),
      ...((videos as { resources?: Array<{ public_id: string }> }).resources ?? []).map((resource) => ({ ...resource, resource_type: "video" as const })),
    ];
    const orphans = resources.filter((resource) => !publicIds.has(resource.public_id));

    let deletedOrphans = 0;
    for (const orphan of orphans) {
      const result = await cloudinary.uploader.destroy(orphan.public_id, {
        resource_type: orphan.resource_type,
        invalidate: true,
      });
      const resultValue = typeof result === "object" && result ? String((result as { result?: unknown }).result ?? "") : "";
      if (["ok", "not found"].includes(resultValue)) {
        deletedOrphans += 1;
      }
    }

    await logCronRun({
      jobName: "cleanup-banners",
      status: "success",
      startedAt,
      result: {
        invalidRecords,
        orphanCloudinaryFiles: orphans.length,
        deletedOrphans,
      },
    });

    return NextResponse.json({
      ok: true,
      invalidRecords,
      orphanCloudinaryFiles: orphans.length,
      deletedOrphans,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo limpiar banners.";
    await logCronRun({
      jobName: "cleanup-banners",
      status: "failed",
      startedAt,
      errorMessage: message,
    });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return runCleanup(request);
}

export async function POST(request: NextRequest) {
  return runCleanup(request);
}
