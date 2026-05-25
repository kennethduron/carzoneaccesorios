import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/forms/auth-card";
import { isAuthEmailConfirmed, isValidAuthEmail } from "@/lib/auth/email-confirmation";
import { createVerificationSuccessToken, verifyVerificationSuccessToken } from "@/lib/auth/verification-token";

async function safeIsAuthEmailConfirmed(email: string) {
  try {
    return await isAuthEmailConfirmed(email);
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const code = typeof params.code === "string" ? params.code : null;
  const tokenHash = typeof params.token_hash === "string" ? params.token_hash : null;
  const verified = typeof params.verified === "string" ? params.verified : null;
  const verificationToken = typeof params.verification_token === "string" ? params.verification_token : null;
  const checkEmail = typeof params.check_email === "string" ? params.check_email : null;
  const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
  const authError = typeof params.error === "string" ? params.error : null;
  const authErrorCode = typeof params.error_code === "string" ? params.error_code : null;
  const authErrorDescription = typeof params.error_description === "string" ? params.error_description : null;

  if (code || tokenHash || authError) {
    const callbackParams = new URLSearchParams();
    const next = typeof params.next === "string" ? params.next : "/verificacion/cuenta-confirmada";
    callbackParams.set("next", next);

    if (code) {
      callbackParams.set("code", code);
    }

    if (tokenHash) {
      callbackParams.set("token_hash", tokenHash);
      callbackParams.set("type", typeof params.type === "string" ? params.type : "signup");
    }

    if (email && isValidAuthEmail(email)) {
      callbackParams.set("email", email);
    }

    if (authError) {
      callbackParams.set("error", authError);
    }

    if (authErrorCode) {
      callbackParams.set("error_code", authErrorCode);
    }

    if (authErrorDescription) {
      callbackParams.set("error_description", authErrorDescription);
    }

    redirect(`/auth/callback?${callbackParams.toString()}`);
  }

  if (verified && !verifyVerificationSuccessToken(verificationToken)) {
    redirect("/login");
  }

  if (verified && email && isValidAuthEmail(email)) {
    const confirmed = await safeIsAuthEmailConfirmed(email);
    if (!confirmed) {
      redirect(`/login?check_email=1&email=${encodeURIComponent(email)}`);
    }
  }

  if (checkEmail && email && isValidAuthEmail(email) && (await safeIsAuthEmailConfirmed(email))) {
    redirect(`/login?verified=1&email=${encodeURIComponent(email)}&verification_token=${encodeURIComponent(createVerificationSuccessToken())}`);
  }

  return (
    <Suspense>
      <AuthCard mode="login" />
    </Suspense>
  );
}
