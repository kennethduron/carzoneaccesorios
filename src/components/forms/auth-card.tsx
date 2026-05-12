"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CarFront, Loader2, LogIn, UserPlus } from "lucide-react";
import { loginWithEmailAction, registerWithEmailAction } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SystemLoadingScreen } from "@/components/system-loading-screen";
import { useToast } from "@/contexts/toast-context";

type AuthCardProps = {
  mode: "login" | "registro";
};

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNextPath = searchParams.get("next") ?? "/cuenta";
  const nextPath = rawNextPath.startsWith("/") && !rawNextPath.startsWith("//") ? rawNextPath : "/cuenta";
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const toast = useToast();

  const isLogin = mode === "login";
  const queryMessage =
    isLogin && searchParams.get("check_email")
      ? "Revisa tu correo y confirma tu cuenta antes de iniciar sesión."
      : isLogin && searchParams.get("registered")
        ? "Cuenta confirmada. Ahora puedes iniciar sesión."
        : "";
  const visibleMessage = message || queryMessage;

  useEffect(() => {
    if (!isLogin) {
      return;
    }

    if (searchParams.get("check_email")) {
      toast.info("Revisa tu correo y confirma tu cuenta antes de iniciar sesión.");
    } else if (searchParams.get("registered")) {
      toast.success("Cuenta confirmada. Ahora puedes iniciar sesión.");
    }
  }, [isLogin, searchParams, toast]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const result = isLogin
      ? await loginWithEmailAction(email, password, nextPath)
      : await registerWithEmailAction({ fullName, email, phone, password, nextPath });

    setLoading(false);
    setMessage(result.message);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    if (result.needsEmailConfirmation) {
      toast.info(result.message);
      router.push(result.redirectTo ?? "/login?check_email=1");
      return;
    }

    toast.success(result.message);
    router.push(result.redirectTo ?? nextPath);
    router.refresh();
  }

  return (
    <section className="min-h-screen bg-[#f7f7f2] px-5 py-10 text-[#1c1d1b]">
      {loading ? <SystemLoadingScreen fullScreen /> : null}
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-md bg-[#1c1d1b] text-white">
              <CarFront size={26} />
            </div>
            <div>
              <p className="text-2xl font-semibold">Car Zone Accesorios</p>
              <p className="text-sm text-black/55">Acceso seguro con Supabase Auth</p>
            </div>
          </div>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">
            {isLogin ? "Ingresa al sistema comercial." : "Crea tu cuenta de cliente."}
          </h1>
          <p className="max-w-lg text-black/60">
            Los roles separan permisos para administración, ventas, bodega, contabilidad y clientes.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="mb-5">
            <h2 className="text-xl font-semibold">{isLogin ? "Iniciar sesión" : "Registro"}</h2>
            <p className="mt-1 text-sm text-black/55">
              {isLogin
                ? "Usa tu correo y contraseña."
                : "Tu cuenta se crea como cliente retail. El mayoreo se aprueba desde admin."}
            </p>
          </div>

          <div className="space-y-3">
            {!isLogin ? (
              <Input
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Nombre completo"
                autoComplete="name"
                required
              />
            ) : null}
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Correo electrónico"
              type="email"
              autoComplete="email"
              required
            />
            {!isLogin ? (
              <Input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="Teléfono"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
              />
            ) : null}
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Contraseña"
              type="password"
              minLength={6}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
            />
          </div>

          {visibleMessage ? (
            <p className="mt-4 rounded-md bg-[#fff2ed] px-3 py-2 text-sm text-[#9b341b]">{visibleMessage}</p>
          ) : null}

          <Button type="submit" variant="dark" className="mt-5 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
            {loading ? "Procesando..." : isLogin ? "Ingresar" : "Crear cuenta"}
          </Button>

          <p className="mt-4 text-center text-sm text-black/55">
            {isLogin ? "¿No tienes cuenta?" : "¿Ya tienes cuenta?"}{" "}
            <Link className="font-medium text-[#246a73]" href={isLogin ? "/registro" : "/login"}>
              {isLogin ? "Regístrate" : "Inicia sesión"}
            </Link>
          </p>
        </form>
      </div>
    </section>
  );
}
