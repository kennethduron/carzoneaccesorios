"use client";

import { useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { requestPasswordResetAction } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function PasswordRecoveryPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const submitLockRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current) {
      return;
    }

    submitLockRef.current = true;
    setLoading(true);
    setMessage("");

    try {
      const result = await requestPasswordResetAction(email);
      setOk(result.ok);
      setMessage(result.message);
    } catch {
      setOk(false);
      setMessage("No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.");
    } finally {
      setLoading(false);
      submitLockRef.current = false;
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
              <p className="text-sm text-black/55">Recuperación segura de cuenta</p>
            </div>
          </div>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">Recupera el acceso a tu cuenta.</h1>
          <p className="max-w-lg text-black/60">
            Ingresa tu correo y, si existe una cuenta registrada, enviaremos un enlace seguro para crear una nueva contraseña.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="mb-5">
            <h2 className="text-xl font-semibold">Olvidé mi contraseña</h2>
            <p className="mt-1 text-sm text-black/55">Por seguridad no confirmamos si el correo existe.</p>
          </div>

          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Correo electrónico"
            type="email"
            autoComplete="email"
            disabled={loading}
            required
          />

          {message ? (
            <p className={`mt-4 rounded-md px-3 py-2 text-sm ${ok ? "bg-[#f4f4f5] text-black/65" : "bg-[#fff2ed] text-[#9b341b]"}`}>
              {message}
            </p>
          ) : null}

          <Button type="submit" variant="dark" className="mt-5 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : <Mail size={18} />}
            {loading ? "Enviando..." : "Enviar instrucciones"}
          </Button>

          <Link href="/login" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-[#e4252c]">
            <ArrowLeft size={16} />
            Volver a iniciar sesión
          </Link>
        </form>
      </div>
    </section>
  );
}
