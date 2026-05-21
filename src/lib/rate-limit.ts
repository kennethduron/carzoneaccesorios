import "server-only";

import { createHash } from "crypto";
import { headers } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const rateLimitMessage = "Demasiados intentos. Espera unos minutos e intenta de nuevo.";

type RateLimitOptions = {
  route: string;
  limit: number;
  windowSeconds: number;
  key?: string | null;
};

type RateLimitRpcRow = {
  allowed: boolean;
  attempts: number;
  retry_after_seconds: number;
};

function firstForwardedIp(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

async function getRequestFingerprint(route: string, key?: string | null) {
  const requestHeaders = await headers();
  const ip =
    firstForwardedIp(requestHeaders.get("x-forwarded-for")) ??
    requestHeaders.get("x-real-ip") ??
    requestHeaders.get("cf-connecting-ip") ??
    "unknown";
  const userAgent = requestHeaders.get("user-agent") ?? "unknown";
  const salt = process.env.RATE_LIMIT_SALT ?? process.env.NEXT_PUBLIC_SITE_URL ?? "car-zone-rate-limit";

  return createHash("sha256")
    .update(`${salt}:${route}:${ip}:${userAgent}:${key ?? ""}`)
    .digest("hex");
}

export async function checkRateLimit(options: RateLimitOptions) {
  try {
    const supabase = await getSupabaseServerClient();
    const identifierHash = await getRequestFingerprint(options.route, options.key);
    const { data, error } = await supabase
      .rpc("check_rate_limit", {
        identifier_hash: identifierHash,
        route_key: options.route,
        max_attempts: options.limit,
        window_seconds: options.windowSeconds,
      })
      .returns<RateLimitRpcRow[]>();

    if (error) {
      console.error("Rate limit check failed", { route: options.route, message: error.message });
      return { ok: true, retryAfter: 0 };
    }

    const row = Array.isArray(data) ? data[0] : null;
    return {
      ok: row?.allowed !== false,
      retryAfter: Number(row?.retry_after_seconds ?? 0),
    };
  } catch (error) {
    console.error("Rate limit check failed", {
      route: options.route,
      message: error instanceof Error ? error.message : "Unknown rate-limit error",
    });
    return { ok: true, retryAfter: 0 };
  }
}
