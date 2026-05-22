"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function VerifiedLoginRedirect() {
  const router = useRouter();

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      router.push("/login?verified=1");
    }, 4500);

    return () => window.clearTimeout(timeout);
  }, [router]);

  return null;
}
