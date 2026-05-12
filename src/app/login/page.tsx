import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/forms/auth-card";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const code = typeof params.code === "string" ? params.code : null;
  const tokenHash = typeof params.token_hash === "string" ? params.token_hash : null;

  if (code || tokenHash) {
    const callbackParams = new URLSearchParams();
    const next = typeof params.next === "string" ? params.next : "/cuenta";
    callbackParams.set("next", next);

    if (code) {
      callbackParams.set("code", code);
    }

    if (tokenHash) {
      callbackParams.set("token_hash", tokenHash);
      callbackParams.set("type", typeof params.type === "string" ? params.type : "email");
    }

    redirect(`/auth/callback?${callbackParams.toString()}`);
  }

  return (
    <Suspense>
      <AuthCard mode="login" />
    </Suspense>
  );
}
