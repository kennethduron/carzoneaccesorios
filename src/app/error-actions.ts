"use server";

import { writeErrorLog } from "@/lib/error-logging";

type GlobalErrorPayload = {
  route?: string | null;
  message?: string | null;
  stack?: string | null;
  digest?: string | null;
  name?: string | null;
};

export async function logGlobalErrorAction(payload: GlobalErrorPayload) {
  await writeErrorLog({
    route: payload.route ?? "/",
    action: "app.error_boundary",
    errorMessage: payload.message?.trim() || "Unknown application error",
    errorStack: payload.stack ?? null,
    metadata: {
      digest: payload.digest ?? null,
      name: payload.name ?? null,
      source: "global-error-boundary",
    },
  });
}
