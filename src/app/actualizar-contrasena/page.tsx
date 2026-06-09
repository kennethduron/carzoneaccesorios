"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, LogIn } from "lucide-react";
import { updatePasswordAfterRecoveryAction } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { getSupabaseBrowserClient } from "@/lib/supabase";

const passwordRecoveryCookieName = "cz-password-recovery";

function setPasswordRecoveryCookie() {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${passwordRecoveryCookieName}=1; Max-Age=900; Path=/; SameSite=Lax${secure}`;
}

function cleanRecoveryHash() {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("recovery", "1");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export default function PasswordUpdatePage() {
  const searchParams = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [initializingRecovery, setInitializingRecovery] = useState(true);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(false);
  const [updated, setUpdated] = useState(false);
  const submitLockRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function initializeRecoverySession() {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const isRecoveryLink = hashParams.get("type") === "recovery";
      const accessToken = hashParams.get("access_token");
      const refreshToken = hashParams.get("refresh_token");

      if (!isRecoveryLink || !accessToken || !refreshToken) {
        if (searchParams.get("error")) {
          setOk(false);
          setMessage("El enlace no es válido o ha expirado. Solicita uno nuevo.");
        }
        setInitializingRecovery(false);
        return;
      }

      try {
        const supabase = getSupabaseBrowserClient();
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        if (!active) {
          return;
        }

        if (error) {
          setOk(false);
          setMessage("El enlace no es válido o ha expirado. Solicita uno nuevo.");
          return;
        }

        setPasswordRecoveryCookie();
        cleanRecoveryHash();
        setOk(false);
        setMessage("");
      } catch {
        if (active) {
          setOk(false);
          setMessage("No pudimos preparar el cambio de contraseña. Solicita un enlace nuevo.");
        }
      } finally {
        if (active) {
          setInitializingRecovery(false);
        }
      }
    }

    void initializeRecoverySession();

    return () => {
      active = false;
    };
  }, [searchParams]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current || updated || initializingRecovery) {
      return;
    }

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

    submitLockRef.current = true;
    setLoading(true);
    const result = await updatePasswordAfterRecoveryAction(password);
    setLoading(false);
    submitLockRef.current = false;
    setOk(result.ok);
    setMessage(result.message);

    if (result.ok) {
      setUpdated(true);
      setPassword("");
      setConfirmPassword("");
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
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">Crear nueva contraseña</h1>
          <p className="max-w-lg text-black/60">
            Esta página solo acepta sesiones creadas desde un enlace de recuperación válido.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="mb-5">
            <h2 className="text-xl font-semibold">Crear nueva contraseña</h2>
            <p className="mt-1 text-sm text-black/55">Usa una contraseña de al menos 8 caracteres.</p>
          </div>

          {!updated ? (
            <div className="space-y-3">
              <PasswordInput
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Nueva contraseña"
                minLength={8}
                autoComplete="new-password"
                disabled={loading || initializingRecovery}
                required
              />
              <PasswordInput
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Confirmar contraseña"
                minLength={8}
                autoComplete="new-password"
                disabled={loading || initializingRecovery}
                required
              />
            </div>
          ) : (
            <div className="rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-[#14532d]">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={22} className="mt-0.5 shrink-0" />
                <div>
                  <h3 className="font-semibold">Contraseña actualizada</h3>
                  <p className="mt-1 text-sm leading-6">Ya puedes iniciar sesión con tu nueva contraseña.</p>
                </div>
              </div>
            </div>
          )}

          {message ? (
            <p className={`mt-4 rounded-md px-3 py-2 text-sm ${ok ? "bg-[#ecfdf5] text-[#166534]" : "bg-[#fff2ed] text-[#9b341b]"}`}>
              {message}
            </p>
          ) : null}

          {!updated ? (
            <Button type="submit" variant="dark" className="mt-5 w-full py-3" disabled={loading || initializingRecovery}>
              {loading || initializingRecovery ? <Loader2 className="animate-spin" size={18} /> : <KeyRound size={18} />}
              {initializingRecovery ? "Preparando enlace..." : loading ? "Actualizando..." : "Actualizar contraseña"}
            </Button>
          ) : (
            <Link
              href="/login?password_updated=1"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-3 text-sm font-semibold text-white"
            >
              <LogIn size={18} />
              Iniciar sesión
            </Link>
          )}

          <Link href="/recuperar-contrasena" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-[#e4252c]">
            <ArrowLeft size={16} />
            Solicitar un enlace nuevo
          </Link>
        </form>
      </div>
    </section>
  );
}
