"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn, MailCheck, RotateCcw, UserPlus } from "lucide-react";
import { loginWithEmailAction, registerWithEmailAction, resendConfirmationEmailAction } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SystemLoadingScreen } from "@/components/system-loading-screen";
import { useToast } from "@/contexts/toast-context";

type AuthCardProps = {
  mode: "login" | "registro";
};

type MessageTone = "info" | "success" | "error";

function safeNextPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/cuenta";
}

function getConfirmationErrorMessage(reason: string | null) {
  if (reason === "expired") {
    return "El enlace de confirmación venció. Solicita uno nuevo.";
  }

  if (reason === "already_confirmed") {
    return "Tu correo ya fue confirmado. Puedes iniciar sesión.";
  }

  if (reason === "missing") {
    return "El enlace de confirmación está incompleto. Solicita uno nuevo.";
  }

  return "No pudimos confirmar tu cuenta. Intenta nuevamente o solicita un nuevo correo de confirmación.";
}

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("info");
  const [showConfirmationHelp, setShowConfirmationHelp] = useState(false);
  const toast = useToast();

  const isLogin = mode === "login";
  const queryMessage = (() => {
    if (!isLogin) {
      return null;
    }

    if (searchParams.get("confirmed")) {
      return {
        text: "Correo confirmado correctamente. Ya puedes iniciar sesión.",
        tone: "success" as const,
        canResend: false,
      };
    }

    if (searchParams.get("check_email")) {
      return {
        text: "Cuenta creada. Te enviamos un correo para confirmar tu cuenta antes de iniciar sesión.",
        tone: "info" as const,
        canResend: true,
      };
    }

    if (searchParams.get("confirmation_error")) {
      return {
        text: getConfirmationErrorMessage(searchParams.get("confirmation_error")),
        tone: "error" as const,
        canResend: true,
      };
    }

    return null;
  })();
  const visibleMessage = message || queryMessage?.text || "";
  const visibleTone = message ? messageTone : queryMessage?.tone ?? "info";
  const shouldShowConfirmationHelp = showConfirmationHelp || Boolean(queryMessage?.canResend);
  const messageClassName =
    visibleTone === "success"
      ? "bg-[#fff1f2] text-[#b91c25]"
      : visibleTone === "error"
        ? "bg-[#fff2ed] text-[#9b341b]"
        : "bg-[#f4f4f5] text-black/65";

  useEffect(() => {
    if (!isLogin) {
      return;
    }

    if (queryMessage?.tone === "success") {
      toast.success(queryMessage.text);
    } else if (queryMessage?.tone === "error") {
      toast.error(queryMessage.text);
    } else if (queryMessage?.text) {
      toast.info(queryMessage.text);
    }
  }, [isLogin, queryMessage?.text, queryMessage?.tone, searchParams, toast]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setShowConfirmationHelp(false);

    const result = isLogin
      ? await loginWithEmailAction(email, password, nextPath)
      : await registerWithEmailAction({ fullName, username, email, phone, password, nextPath });

    setLoading(false);
    setMessage(result.message);

    if (!result.ok) {
      setMessageTone("error");
      setShowConfirmationHelp(result.message.toLowerCase().includes("confirm"));
      toast.error(result.message);
      return;
    }

    if (result.needsEmailConfirmation) {
      setMessageTone("info");
      setShowConfirmationHelp(true);
      toast.info(result.message);
      router.push(result.redirectTo ?? `/login?check_email=1&email=${encodeURIComponent(email)}`);
      return;
    }

    setMessageTone("success");
    toast.success(result.message);
    router.push(result.redirectTo ?? nextPath);
    router.refresh();
  }

  async function handleResendConfirmation() {
    setResending(true);
    setMessage("");

    const result = await resendConfirmationEmailAction(email);

    setResending(false);
    setMessage(result.message);
    setMessageTone(result.ok ? "success" : "error");
    setShowConfirmationHelp(true);

    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  }

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-10 text-[#080808]">
      {loading ? <SystemLoadingScreen fullScreen /> : null}
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="grid size-14 place-items-center rounded-md bg-white p-1 shadow-sm ring-1 ring-black/10">
              <Image src="/brand/car-zone-logo.jpeg" alt="Car Zone Accesorios" width={96} height={56} className="h-auto w-full object-contain" priority />
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
                ? "Usa tu correo o nombre de usuario y contraseña."
                : "Te enviaremos un correo para confirmar tu cuenta antes de iniciar sesión."}
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
            {!isLogin ? (
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Nombre de usuario"
                autoComplete="username"
                minLength={3}
                maxLength={30}
                required
              />
            ) : null}
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={isLogin ? "Correo o usuario" : "Correo electrónico"}
              type={isLogin ? "text" : "email"}
              autoComplete={isLogin ? "username" : "email"}
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

          {visibleMessage ? <p className={`mt-4 rounded-md px-3 py-2 text-sm ${messageClassName}`}>{visibleMessage}</p> : null}

          {isLogin && shouldShowConfirmationHelp ? (
            <div className="mt-4 rounded-md border border-black/10 bg-[#f4f4f5] p-3">
              <p className="text-sm text-black/65">
                Revisa tu bandeja de entrada o spam. Si el enlace venció o no llegó, puedes solicitar uno nuevo.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  disabled={resending || !email.trim()}
                  onClick={handleResendConfirmation}
                >
                  {resending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
                  {resending ? "Enviando..." : "Reenviar confirmación"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    setEmail("");
                    setMessage("");
                  }}
                >
                  <RotateCcw size={17} />
                  Cambiar correo
                </Button>
              </div>
            </div>
          ) : null}

          <Button type="submit" variant="dark" className="mt-5 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
            {loading ? "Procesando..." : isLogin ? "Ingresar" : "Crear cuenta"}
          </Button>

          <p className="mt-4 text-center text-sm text-black/55">
            {isLogin ? "¿No tienes cuenta?" : "¿Ya tienes cuenta?"}{" "}
            <Link className="font-medium text-[#e4252c]" href={isLogin ? "/registro" : "/login"}>
              {isLogin ? "Regístrate" : "Inicia sesión"}
            </Link>
          </p>
        </form>
      </div>
    </section>
  );
}

