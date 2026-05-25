import "server-only";

import { createHash } from "crypto";
import { headers } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { rateLimitCustomerMessage } from "@/lib/operational-errors";

export const rateLimitMessage = "Por seguridad, hemos pausado temporalmente los intentos. Intenta nuevamente en unos minutos.";

export function getRateLimitMessage(retryAfterSeconds?: number) {
  return rateLimitCustomerMessage(retryAfterSeconds);
}

type RateLimitOptions = {
  route: string;
  limit: number;
  windowSeconds: number;
  key?: string | null;
  scope?: "ip-user-agent-key" | "key" | "ip-user-agent" | "ip";
};

type RateLimitRpcRow = {
  allowed: boolean;
  attempts: number;
  retry_after_seconds: number;
};

export type RateLimitResult = {
  ok: boolean;
  retryAfter: number;
  attempts: number;
  route: string;
  scope: NonNullable<RateLimitOptions["scope"]>;
};

function firstForwardedIp(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

async function getRequestFingerprint(route: string, key?: string | null) {
  const requestHeaders = await headers();
  const salt = process.env.RATE_LIMIT_SALT ?? process.env.NEXT_PUBLIC_SITE_URL ?? "car-zone-rate-limit";
  const ip = getRequestIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent") ?? "unknown";

  return createHash("sha256")
    .update(`${salt}:${route}:${ip}:${userAgent}:${key ?? ""}`)
    .digest("hex");
}

function getRequestIp(requestHeaders: Headers) {
  return (
    firstForwardedIp(requestHeaders.get("x-forwarded-for")) ??
    requestHeaders.get("x-real-ip") ??
    requestHeaders.get("cf-connecting-ip") ??
    "unknown"
  );
}

async function getRateLimitIdentifier(options: RateLimitOptions) {
  if (!options.scope || options.scope === "ip-user-agent-key") {
    return getRequestFingerprint(options.route, options.key);
  }

  const requestHeaders = await headers();
  const ip =
    getRequestIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent") ?? "unknown";
  const salt = process.env.RATE_LIMIT_SALT ?? process.env.NEXT_PUBLIC_SITE_URL ?? "car-zone-rate-limit";
  const safeKey = options.key?.trim().toLowerCase() ?? "";

  if (options.scope === "key") {
    return createHash("sha256").update(`${salt}:${options.route}:key:${safeKey}`).digest("hex");
  }

  if (options.scope === "ip") {
    return createHash("sha256").update(`${salt}:${options.route}:ip:${ip}`).digest("hex");
  }

  return createHash("sha256")
    .update(`${salt}:${options.route}:device:${ip}:${userAgent}`)
    .digest("hex");
}

export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const scope = options.scope ?? "ip-user-agent-key";
  try {
    const supabase = await getSupabaseServerClient();
    const identifierHash = await getRateLimitIdentifier(options);
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
      return { ok: true, retryAfter: 0, attempts: 0, route: options.route, scope };
    }

    const row = Array.isArray(data) ? data[0] : null;
    return {
      ok: row?.allowed !== false,
      retryAfter: Number(row?.retry_after_seconds ?? 0),
      attempts: Number(row?.attempts ?? 0),
      route: options.route,
      scope,
    };
  } catch (error) {
    console.error("Rate limit check failed", {
      route: options.route,
      message: error instanceof Error ? error.message : "Unknown rate-limit error",
    });
    return { ok: true, retryAfter: 0, attempts: 0, route: options.route, scope };
  }
}
