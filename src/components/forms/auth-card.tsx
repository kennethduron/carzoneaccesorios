"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, LogIn, MailCheck, RotateCcw, UserPlus } from "lucide-react";
import {
  checkRegisteredEmailVerificationAction,
  loginWithEmailAction,
  registerWithEmailAction,
  resendConfirmationEmailAction,
} from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { SystemLoadingScreen } from "@/components/system-loading-screen";
import { WholesaleSignupInfo } from "@/components/store/wholesale-program-info";
import { useToast } from "@/contexts/toast-context";

type AuthCardProps = {
  mode: "login" | "registro";
};

type MessageTone = "info" | "success" | "error";

const VERIFICATION_POLL_INTERVAL_MS = 8_000;
const VERIFICATION_POLL_MAX_MS = 3 * 60_000;

function safeNextPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/cuenta";
}

function looksLikeValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function getConfirmationErrorMessage(reason: string | null) {
  if (reason === "expired") {
    return "El enlace de verificación venció. Solicita uno nuevo.";
  }

  if (reason === "already_confirmed") {
    return "Tu correo ya fue confirmado. Puedes iniciar sesión.";
  }

  if (reason === "missing") {
    return "El enlace de verificación está incompleto. Solicita uno nuevo.";
  }

  return "No pudimos verificar tu cuenta. Intenta nuevamente o solicita un nuevo correo de verificación.";
}

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [phone, setPhone] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [city, setCity] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("info");
  const [showConfirmationHelp, setShowConfirmationHelp] = useState(false);
  const [registrationEmailSent, setRegistrationEmailSent] = useState(false);
  const [autoPollingVerification, setAutoPollingVerification] = useState(false);
  const [verificationDetected, setVerificationDetected] = useState(false);
  const [verifiedLoginEmail, setVerifiedLoginEmail] = useState<string | null>(null);
  const submitLockRef = useRef(false);
  const resendLockRef = useRef(false);
  const verificationCheckLockRef = useRef(false);
  const toast = useToast();

  const isLogin = mode === "login" || Boolean(verifiedLoginEmail);
  const queryMessage = (() => {
    if (!isLogin) {
      return null;
    }

    if (searchParams.get("reason") === "session_expired") {
      return {
        text: "Su sesión expiró. Inicie sesión nuevamente.",
        tone: "info" as const,
        canResend: false,
      };
    }

    if (searchParams.get("confirmed")) {
      return {
        text: "Correo electrónico confirmado correctamente. Ya puedes iniciar sesión.",
        tone: "success" as const,
        canResend: false,
      };
    }

    if (searchParams.get("verified")) {
      return {
        text: "Cuenta verificada correctamente. Ahora puedes iniciar sesión.",
        tone: "success" as const,
        canResend: false,
      };
    }

    if (searchParams.get("check_email")) {
      return {
        text: "Revisa tu correo para verificar tu cuenta.",
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

    if (searchParams.get("password_updated")) {
      return {
        text: "Tu contraseña fue actualizada correctamente.",
        tone: "success" as const,
        canResend: false,
      };
    }

    return null;
  })();
  const visibleMessage = message || queryMessage?.text || "";
  const visibleTone = message ? messageTone : queryMessage?.tone ?? "info";
  const shouldShowConfirmationHelp = showConfirmationHelp || Boolean(queryMessage?.canResend);
  const isCheckEmailMode =
    isLogin &&
    Boolean(searchParams.get("check_email")) &&
    !searchParams.get("verified") &&
    !searchParams.get("confirmed");
  const messageClassName =
    visibleTone === "success"
      ? "bg-[#ecfdf5] text-[#166534]"
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
    if (submitLockRef.current) {
      return;
    }

    submitLockRef.current = true;
    setLoading(true);
    setMessage("");
    setShowConfirmationHelp(false);

    try {
      const result = isLogin
        ? await loginWithEmailAction(email, password, nextPath)
        : await registerWithEmailAction({
            fullName,
            username,
            email,
            phone,
            password,
            businessName,
            taxId,
            city,
            nextPath,
          });

      setMessage(result.message);

      if (!result.ok) {
        setMessageTone("error");
        setShowConfirmationHelp(result.message.toLowerCase().includes("confirm") || result.message.toLowerCase().includes("verific"));
        toast.error(result.message);
        return;
      }

      if (result.needsEmailConfirmation) {
        setMessageTone("info");
        setShowConfirmationHelp(true);
        setRegistrationEmailSent(true);
        toast.success(result.message);
        return;
      }

      setMessageTone("success");
      toast.success(result.message);
      router.push(result.redirectTo ?? nextPath);
      router.refresh();
    } catch {
      const errorMessage = "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.";
      setMessage(errorMessage);
      setMessageTone("error");
      toast.error(errorMessage);
    } finally {
      setLoading(false);
      submitLockRef.current = false;
    }
  }

  async function handleResendConfirmation() {
    if (resendLockRef.current) {
      return;
    }

    resendLockRef.current = true;
    setResending(true);
    setMessage("");

    try {
      const result = await resendConfirmationEmailAction(email);

      setMessage(result.message);
      setMessageTone(result.ok ? "success" : "error");
      setShowConfirmationHelp(true);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch {
      const errorMessage = "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.";
      setMessage(errorMessage);
      setMessageTone("error");
      setShowConfirmationHelp(true);
      toast.error(errorMessage);
    } finally {
      setResending(false);
      resendLockRef.current = false;
    }
  }

  const runVerificationCheck = useCallback(async (mode: "manual" | "auto") => {
    if (verificationCheckLockRef.current) {
      return false;
    }

    const emailToCheck = email.trim().toLowerCase();
    if (!looksLikeValidEmail(emailToCheck)) {
      if (mode === "manual") {
        const errorMessage = "Ingresa el correo que usaste para crear tu cuenta.";
        setMessage(errorMessage);
        setMessageTone("error");
        toast.error(errorMessage);
      }
      return false;
    }

    verificationCheckLockRef.current = true;
    if (mode === "manual") {
      setCheckingVerification(true);
      setMessage("");
    }

    try {
      const result = await checkRegisteredEmailVerificationAction(emailToCheck);

      if (!result.ok) {
        if (mode === "manual") {
          setMessage(result.message);
          setMessageTone("error");
          setShowConfirmationHelp(true);
          toast.error(result.message);
        }
        return false;
      }

      setVerificationDetected(true);
      setVerifiedLoginEmail(emailToCheck);
      setEmail(emailToCheck);
      setPassword("");
      setRegistrationEmailSent(false);
      setAutoPollingVerification(false);
      setMessage(result.message);
      setMessageTone("success");
      setShowConfirmationHelp(false);
      toast.success(result.message);
      router.replace(result.redirectTo ?? `/login?email=${encodeURIComponent(emailToCheck)}`);
      router.refresh();
      return true;
    } catch {
      const errorMessage = "No pudimos revisar la verificación en este momento. Inténtalo nuevamente.";
      if (mode === "manual") {
        setMessage(errorMessage);
        setMessageTone("error");
        toast.error(errorMessage);
      }
      return false;
    } finally {
      if (mode === "manual") {
        setCheckingVerification(false);
      }
      verificationCheckLockRef.current = false;
    }
  }, [email, router, toast]);

  async function handleVerificationCheck() {
    await runVerificationCheck("manual");
  }

  useEffect(() => {
    const shouldPoll =
      !verificationDetected &&
      looksLikeValidEmail(email) &&
      (registrationEmailSent || isCheckEmailMode);

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const poll = async () => {
      if (cancelled) {
        return;
      }

      if (Date.now() - startedAt > VERIFICATION_POLL_MAX_MS) {
        setAutoPollingVerification(false);
        return;
      }

      setAutoPollingVerification(true);
      const confirmed = await runVerificationCheck("auto");

      if (cancelled || confirmed) {
        setAutoPollingVerification(false);
        return;
      }

      if (Date.now() - startedAt + VERIFICATION_POLL_INTERVAL_MS <= VERIFICATION_POLL_MAX_MS) {
        timer = setTimeout(poll, VERIFICATION_POLL_INTERVAL_MS);
        return;
      }

      setAutoPollingVerification(false);
    };

    timer = setTimeout(poll, 1_000);

    return () => {
      cancelled = true;
      setAutoPollingVerification(false);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [email, isCheckEmailMode, registrationEmailSent, runVerificationCheck, verificationDetected]);

  return (
    <section className="min-h-screen bg-[#f4f4f5] px-5 py-10 text-[#080808]">
      {loading ? <SystemLoadingScreen fullScreen /> : null}
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="grid size-14 place-items-center rounded-md bg-white p-1 shadow-sm ring-1 ring-black/10">
              <Image src="/brand/car-zone-logo.jpeg" alt="Car Zone Accesorios" width={96} height={56} className="h-auto w-full object-contain" preload />
            </div>
            <div>
              <p className="text-2xl font-semibold">Car Zone Accesorios</p>
              <p className="text-sm text-black/55">Acceso seguro para clientes</p>
            </div>
          </div>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">
            {isLogin ? "Ingresa a tu cuenta." : "Crea tu cuenta de cliente."}
          </h1>
          <p className="max-w-lg text-black/60">
            {isLogin
              ? "Accede para revisar tus pedidos, facturas y beneficios."
              : "Regístrate para comprar más rápido, revisar tus pedidos y solicitar acceso mayorista."}
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

          {!isLogin && registrationEmailSent ? (
            <div className="rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] p-4 text-[#14532d]">
              <div className="flex items-start gap-3">
                <CheckCircle2 size={22} className="mt-0.5 shrink-0" />
                <div>
                  <h3 className="font-semibold">Cuenta creada correctamente.</h3>
                  <p className="mt-2 text-sm leading-6">
                    Te enviamos un correo para verificar tu dirección.
                  </p>
                  <p className="mt-2 text-sm leading-6">
                    Cuando confirmes tu correo, esta pantalla se actualizará automáticamente para iniciar sesión.
                  </p>
                  {autoPollingVerification ? (
                    <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium">
                      <Loader2 className="animate-spin" size={16} />
                      Esperando confirmación del correo...
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-4 grid gap-2 lg:grid-cols-3">
                <Link
                  href={`/login?check_email=1&email=${encodeURIComponent(email)}`}
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white"
                >
                  <LogIn size={17} />
                  Ir a iniciar sesión
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resending || checkingVerification || !email.trim()}
                  onClick={handleResendConfirmation}
                >
                  {resending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
                  {resending ? "Enviando..." : "Reenviar correo"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={checkingVerification || resending || !email.trim()}
                  onClick={handleVerificationCheck}
                >
                  {checkingVerification ? <Loader2 className="animate-spin" size={17} /> : <CheckCircle2 size={17} />}
                  {checkingVerification ? "Revisando..." : "Ya verifiqué mi cuenta"}
                </Button>
              </div>
              {message ? <p className={`mt-3 rounded-md px-3 py-2 text-sm ${messageClassName}`}>{message}</p> : null}
            </div>
          ) : null}

          {!registrationEmailSent ? <div className="space-y-3">
            {!isLogin ? (
              <AuthField label="Nombre completo" htmlFor="auth-full-name">
                <Input
                  id="auth-full-name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            {!isLogin ? (
              <AuthField label="Nombre de usuario" htmlFor="auth-username">
                <Input
                  id="auth-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  minLength={3}
                  maxLength={30}
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            <AuthField label={isLogin ? "Correo electrónico o usuario" : "Correo electrónico"} htmlFor="auth-email">
              <Input
                id="auth-email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setVerificationDetected(false);
                }}
                type={isLogin ? "text" : "email"}
                autoComplete={isLogin ? "username" : "email"}
                disabled={loading}
                required
              />
            </AuthField>
            {!isLogin ? (
              <AuthField label="Teléfono" htmlFor="auth-phone">
                <Input
                  id="auth-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  disabled={loading}
                  required
                />
              </AuthField>
            ) : null}
            <AuthField label="Contraseña" htmlFor="auth-password">
              <PasswordInput
                id="auth-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={isLogin ? undefined : 8}
                autoComplete={isLogin ? "current-password" : "new-password"}
                disabled={loading}
                required
              />
            </AuthField>
            {!isLogin ? (
              <fieldset className="space-y-3 rounded-lg border border-black/10 bg-[#fafafa] p-4">
                <legend className="px-1 text-sm font-semibold">Datos del negocio (opcional)</legend>
                <p className="text-xs leading-5 text-black/55">
                  Puedes dejarlos vacíos y completarlos una sola vez desde tu cuenta después de verificar el correo.
                </p>
                <AuthField label="Nombre del negocio (opcional)" htmlFor="auth-business-name">
                  <Input
                    id="auth-business-name"
                    value={businessName}
                    onChange={(event) => setBusinessName(event.target.value)}
                    maxLength={160}
                    autoComplete="organization"
                    disabled={loading}
                  />
                </AuthField>
                <AuthField label="RTN (opcional)" htmlFor="auth-tax-id">
                  <Input
                    id="auth-tax-id"
                    value={taxId}
                    onChange={(event) => setTaxId(event.target.value)}
                    maxLength={40}
                    inputMode="numeric"
                    disabled={loading}
                    aria-describedby="auth-tax-id-help"
                  />
                  <span id="auth-tax-id-help" className="mt-1 block text-xs text-black/50">14 dígitos; puedes usar espacios o guiones.</span>
                </AuthField>
                <AuthField label="Ubicación (ciudad/municipio) (opcional)" htmlFor="auth-city">
                  <Input
                    id="auth-city"
                    value={city}
                    onChange={(event) => setCity(event.target.value)}
                    maxLength={120}
                    autoComplete="address-level2"
                    disabled={loading}
                  />
                </AuthField>
              </fieldset>
            ) : null}
            {!isLogin ? <WholesaleSignupInfo /> : null}
          </div> : null}

          {isLogin ? (
            <div className="mt-3 text-right">
              <Link className="text-sm font-medium text-[#e4252c]" href="/recuperar-contrasena">
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
          ) : null}

          {visibleMessage && !registrationEmailSent ? <p className={`mt-4 rounded-md px-3 py-2 text-sm ${messageClassName}`}>{visibleMessage}</p> : null}

          {isLogin && shouldShowConfirmationHelp ? (
            <div className="mt-4 rounded-md border border-black/10 bg-[#f4f4f5] p-3">
              <p className="text-sm text-black/65">
                Revisa tu bandeja de entrada o spam. Si el enlace venció o no llegó, puedes solicitar uno nuevo.
              </p>
              {isCheckEmailMode ? (
                <p className="mt-2 text-sm text-black/65">
                  Cuando confirmes tu correo, esta pantalla se actualizará automáticamente para iniciar sesión.
                </p>
              ) : null}
              {autoPollingVerification ? (
                <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[#166534]">
                  <Loader2 className="animate-spin" size={16} />
                  Esperando confirmación del correo...
                </p>
              ) : null}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  disabled={resending || loading || !email.trim()}
                  onClick={handleResendConfirmation}
                >
                  {resending ? <Loader2 className="animate-spin" size={17} /> : <MailCheck size={17} />}
                  {resending ? "Enviando..." : "Reenviar verificación"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  disabled={resending || loading}
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

          {!registrationEmailSent ? <Button type="submit" variant="dark" className="mt-5 min-h-11 w-full py-3" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} /> : isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
            {loading ? "Procesando..." : isLogin ? "Ingresar" : "Crear cuenta"}
          </Button> : null}

          {!registrationEmailSent ? <p className="mt-4 text-center text-sm text-black/55">
            {isLogin ? "¿No tienes cuenta?" : "¿Ya tienes cuenta?"}{" "}
            <Link className="font-medium text-[#e4252c]" href={isLogin ? "/registro" : "/login"}>
              {isLogin ? "Regístrate" : "Inicia sesión"}
            </Link>
          </p> : null}
        </form>
      </div>
    </section>
  );
}

function AuthField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-sm font-medium text-black/70">{label}</span>
      {children}
    </label>
  );
}

