import { Suspense } from "react";
import { AuthCard } from "@/components/forms/auth-card";

export default function RegistroPage() {
  return (
    <Suspense>
      <AuthCard mode="registro" />
    </Suspense>
  );
}
