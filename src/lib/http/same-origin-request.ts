export type SameOriginCheck =
  | { ok: true }
  | { ok: false; reason: "ORIGIN_MISSING" | "ORIGIN_INVALID" | "CROSS_SITE_REQUEST" };

export function verifySameOriginRequest(request: Request): SameOriginCheck {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return { ok: false, reason: "CROSS_SITE_REQUEST" };
  }

  const origin = request.headers.get("origin");
  if (!origin) return { ok: false, reason: "ORIGIN_MISSING" };

  try {
    return new URL(origin).origin === new URL(request.url).origin
      ? { ok: true }
      : { ok: false, reason: "CROSS_SITE_REQUEST" };
  } catch {
    return { ok: false, reason: "ORIGIN_INVALID" };
  }
}
