import type { NextRequest } from "next/server";
import { verifyCronRequest } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function run(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  return Response.json(
    {
      ok: false,
      message: "El backup por Google Drive esta desactivado. Usa /api/cron/backups/email.",
    },
    { status: 410 },
  );
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
