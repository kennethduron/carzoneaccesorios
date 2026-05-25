"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function VerifiedLoginRedirect({ verificationToken }: { verificationToken: string }) {
  const router = useRouter();

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      router.push(`/login?verified=1&verification_token=${encodeURIComponent(verificationToken)}`);
    }, 4500);

    return () => window.clearTimeout(timeout);
  }, [router, verificationToken]);

  return null;
}
