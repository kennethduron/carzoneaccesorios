"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { updatePasswordAfterRecoveryAction } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";

export default function PasswordResetPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(
    searchParams.get("error") ? "El enlace no es válido o expiró. Solicita uno nuevo." : "",
  );
  const [ok, setOk] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (password.length < 8) {
      setOk(false);
      setMessage("La contraseña debe tener al menos 8 caracteres.");
      return;
    }

    if (password !== confirmPassword) {
      setOk(false);
      setMessage("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    const result = await updatePasswordAfterRecoveryAction(password);
    setLoading(false);
    setOk(result.ok);
    setMessage(result.message);

    if (result.ok) {
      router.push(result.redirectTo ?? "/login?password_updated=1");
      router.refresh();
    }
  }

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-10 text-[#080808]">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="grid size-14 place-items-center rounded-md bg-white p-1 shadow-sm ring-1 ring-black/10">
              <Image src="/brand/car-zone-logo.jpeg" alt="Car Zone Accesorios" width={96} height={56} className="h-auto w-full object-contain" preload />
            </div>
            <div>
              <p className="text-2xl font-semibold">Car Zone Accesorios</p>
              <p className="text-sm text-black/55">Cambio privado de contraseña</p>
            </div>
          </div>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">Crea una nueva contraseña.</h1>
          <p className="max-w-lg text-black/60">
            Esta página solo acepta sesiones creadas desde un enlace de recuperación válido.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="mb-5">
            <h2 className="text-xl font-semibold">Restablecer contraseña</h2>
            <p className="mt-1 text-sm text-black/55">Usa una contraseña de al menos 8 caracteres.</p>
          </div>

          <div className="space-y-3">
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nueva contraseña"
              minLength={8}
              autoComplete="new-password"
              required
            />
            <PasswordInput
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirmar contraseña"
              minLength={8}
              autoComplete="new-password"
              required
            />
          </div>

          {message ? (
            <p className={`mt-4 rounded-md px-3 py-2 text-sm ${ok ? "bg-[#fff1f2] text-[#b91c25]" : "bg-[#fff2ed] text-[#9b341b]"}`}>
              {message}
            </p>
          ) : null}

          <Button type="submit" variant="dark" className="mt-5 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : <KeyRound size={18} />}
            {loading ? "Actualizando..." : "Actualizar contraseña"}
          </Button>

          <Link href="/recuperar-contrasena" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-[#e4252c]">
            <ArrowLeft size={16} />
            Solicitar un enlace nuevo
          </Link>
        </form>
      </div>
    </section>
  );
}
