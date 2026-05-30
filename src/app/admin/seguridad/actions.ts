"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AppRole, AuthProfile } from "@/types/auth";
import type { BackupType } from "@/types/security";
import { cleanText } from "@/utils/validation";
import { validateUsername } from "@/utils/usernames";

type SecurityMutationResult = {
  ok: boolean;
  message: string;
};

type CreateOperationalUserInput = {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  role: AppRole;
  temporaryPassword: string;
};

type TargetUserRecord = {
  id: string;
  email: string | null;
  active: boolean;
  role: AppRole;
};

type RequestAuditContext = {
  ipAddress: string | null;
  userAgent: string | null;
};

const ownerAssignableRoles: AppRole[] = ["vendedor", "bodega", "contadora", "soporte", "cliente"];
const adminAssignableRoles: AppRole[] = ["admin", "business_owner", "vendedor", "bodega", "contadora", "soporte", "cliente"];
const operationalCreateRoles: AppRole[] = ["vendedor", "bodega", "contadora", "soporte"];
const operationalManageRoles: AppRole[] = ["vendedor", "bodega", "contadora", "soporte", "cliente"];
const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
const technicalConfirmation = "CONFIRMAR CAMBIO TECNICO";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d]/g, "");
}

function normalizeNullableEmail(email: string | null | undefined) {
  return (email ?? "").trim().toLowerCase();
}

function hasTechnicalControl(profile: AuthProfile) {
  return profile.role === "technical_owner" || normalizeNullableEmail(profile.email) === protectedTechnicalEmail;
}

function hasPermission(profile: AuthProfile, permission: string) {
  return (profile.permissions as string[]).includes(permission);
}

function canManageUsers(profile: AuthProfile) {
  return (
    hasTechnicalControl(profile) ||
    profile.role === "admin" ||
    hasPermission(profile, "users:manage") ||
    hasPermission(profile, "users:manage_operational")
  );
}

function canAssignRoles(profile: AuthProfile) {
  return (
    hasTechnicalControl(profile) ||
    profile.role === "admin" ||
    hasPermission(profile, "roles:assign") ||
    hasPermission(profile, "roles:assign_operational")
  );
}

function canAssignRole(profile: AuthProfile, targetRole: AppRole) {
  if (hasTechnicalControl(profile)) {
    return targetRole === "technical_owner" || adminAssignableRoles.includes(targetRole);
  }

  if (profile.role === "business_owner") {
    return ownerAssignableRoles.includes(targetRole);
  }

  if (profile.role === "admin") {
    return adminAssignableRoles.includes(targetRole);
  }

  return false;
}

function canModifyTarget(profile: AuthProfile, target: TargetUserRecord) {
  const targetEmail = normalizeNullableEmail(target.email);
  const isProtectedTechnicalUser = targetEmail === protectedTechnicalEmail || target.role === "technical_owner";

  if (hasTechnicalControl(profile)) {
    return true;
  }

  if (isProtectedTechnicalUser || target.role === "admin") {
    return false;
  }

  if (profile.role === "business_owner") {
    return operationalManageRoles.includes(target.role);
  }

  if (profile.role === "admin") {
    return target.role !== "technical_owner";
  }

  return false;
}

function protectedTargetMessage(target?: TargetUserRecord | null) {
  const isTechnical =
    target &&
    (normalizeNullableEmail(target.email) === protectedTechnicalEmail ||
      target.role === "technical_owner" ||
      target.role === "admin");

  if (isTechnical) {
    return "Este usuario está protegido y solo puede ser modificado por el administrador técnico.";
  }

  return "No tienes permiso para modificar este usuario.";
}

function roleErrorMessage(role: AppRole) {
  if (["technical_owner", "admin", "business_owner"].includes(role)) {
    return "No tienes permiso para asignar roles técnicos.";
  }

  return "No tienes autorización para asignar este rol.";
}

function userFriendlyRoleError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("roles tecnicos") || normalized.includes("rol tecnico") || normalized.includes("asignar roles técnicos")) {
    return "No tienes permiso para asignar roles técnicos.";
  }

  if (
    normalized.includes("cuenta tecnica protegida") ||
    normalized.includes("usuario esta protegido") ||
    normalized.includes("usuarios tecnicos") ||
    normalized.includes("administrador tecnico")
  ) {
    return "Este usuario está protegido y solo puede ser modificado por el administrador técnico.";
  }

  if (normalized.includes("ultimo administrador operativo")) {
    return "No puedes degradar o suspender al último administrador operativo.";
  }

  if (normalized.includes("no tienes autorizacion")) {
    return "No tienes autorización para realizar esta acción.";
  }

  return message;
}

function roleDescription(role: AppRole) {
  return role.replace("_", " ");
}

async function requestAuditContext(): Promise<RequestAuditContext> {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  return {
    ipAddress: forwardedFor || headerStore.get("x-real-ip") || null,
    userAgent: headerStore.get("user-agent") || null,
  };
}

async function getTargetUserRecord(userId: string): Promise<TargetUserRecord | null> {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("id,email,active,roles(name)")
    .eq("id", userId)
    .maybeSingle<{ id: string; email: string | null; active: boolean; roles: { name: AppRole } | null }>();

  if (!data) {
    return null;
  }

  return {
    id: data.id,
    email: data.email,
    active: data.active,
    role: data.roles?.name ?? "cliente",
  };
}

async function writeSecurityAudit({
  profile,
  action,
  target,
  oldData,
  newData,
  context,
}: {
  profile: AuthProfile;
  action: string;
  target: TargetUserRecord | { id: string } | null;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  context?: RequestAuditContext;
}) {
  const auditContext = context ?? (await requestAuditContext());
  const admin = getSupabaseAdminClient();

  await admin.from("audit_logs").insert({
    user_id: profile.id,
    actor_role: profile.role,
    table_name: "users",
    record_id: target?.id ?? null,
    action,
    old_data: oldData ?? null,
    new_data: {
      actor_email: profile.email,
      actor_role: profile.role,
      ...(newData ?? {}),
    },
    ip_address: auditContext.ipAddress,
    user_agent: auditContext.userAgent,
  });
}

function targetOldData(target: TargetUserRecord | null) {
  if (!target) {
    return null;
  }

  return {
    email: target.email,
    role: target.role,
    active: target.active,
  };
}

export async function requestBackupAction(
  backupType: BackupType,
  notes: string,
): Promise<SecurityMutationResult> {
  const profile = await requirePermission("settings:manage");

  const allowedTypes: BackupType[] = ["manual", "scheduled", "pre_deploy"];
  if (!allowedTypes.includes(backupType)) {
    return { ok: false, message: "Tipo de backup no válido." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("backup_logs")
    .insert({
      requested_by: profile.id,
      backup_type: backupType,
      status: "requested",
      notes: cleanText(notes) || "Backup solicitado desde panel de seguridad.",
    })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "backup_logs",
    recordId: data.id,
    action: "backup.requested",
    newData: { backupType },
  });

  revalidatePath("/admin/seguridad");
  return {
    ok: true,
    message: "Solicitud de backup registrada. Ejecuta el respaldo desde Supabase o tu tarea programada.",
  };
}

export async function changeUserRoleAction(userId: string, role: AppRole): Promise<SecurityMutationResult> {
  const profile = await requireSession();
  const context = await requestAuditContext();

  if (!canManageUsers(profile) || !canAssignRoles(profile)) {
    await writeSecurityAudit({
      profile,
      action: "user.role_change_blocked",
      target: { id: userId },
      newData: { result: "blocked", reason: "missing_permission", requested_role: role },
      context,
    });
    return { ok: false, message: "No tienes autorización para asignar roles." };
  }

  if (!canAssignRole(profile, role)) {
    await writeSecurityAudit({
      profile,
      action: "user.role_change_blocked",
      target: { id: userId },
      newData: { result: "blocked", reason: "role_not_allowed", requested_role: role },
      context,
    });
    return { ok: false, message: roleErrorMessage(role) };
  }

  const target = await getTargetUserRecord(userId);
  if (!target) {
    return { ok: false, message: "Usuario no encontrado." };
  }

  if (!canModifyTarget(profile, target)) {
    await writeSecurityAudit({
      profile,
      action: "user.role_change_blocked",
      target,
      oldData: targetOldData(target),
      newData: { result: "blocked", reason: "protected_or_not_operational", requested_role: role },
      context,
    });
    return { ok: false, message: protectedTargetMessage(target) };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("change_user_role", {
    target_user_id: userId,
    target_role_name: role,
    change_reason: `Cambio solicitado desde /admin/seguridad por ${profile.email ?? profile.id}.`,
    technical_confirmation: hasTechnicalControl(profile) ? technicalConfirmation : null,
    actor_ip: context.ipAddress,
    actor_user_agent: context.userAgent,
  });

  if (error) {
    return { ok: false, message: userFriendlyRoleError(error.message) };
  }

  revalidatePath("/admin/seguridad");
  revalidatePath("/admin");
  return { ok: true, message: "Rol actualizado correctamente." };
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<SecurityMutationResult> {
  const profile = await requireSession();
  const context = await requestAuditContext();

  if (!canManageUsers(profile)) {
    await writeSecurityAudit({
      profile,
      action: active ? "user.reactivate_blocked" : "user.suspend_blocked",
      target: { id: userId },
      newData: { result: "blocked", reason: "missing_permission", requested_active: active },
      context,
    });
    return { ok: false, message: "No tienes autorización para modificar usuarios." };
  }

  const target = await getTargetUserRecord(userId);
  if (!target) {
    return { ok: false, message: "Usuario no encontrado." };
  }

  if (!canModifyTarget(profile, target)) {
    await writeSecurityAudit({
      profile,
      action: active ? "user.reactivate_blocked" : "user.suspend_blocked",
      target,
      oldData: targetOldData(target),
      newData: { result: "blocked", reason: "protected_or_not_operational", requested_active: active },
      context,
    });
    return { ok: false, message: protectedTargetMessage(target) };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("set_user_active", {
    target_user_id: userId,
    next_active: active,
    change_reason: `${active ? "Reactivación" : "Suspensión"} solicitada desde /admin/seguridad por ${profile.email ?? profile.id}.`,
    technical_confirmation: hasTechnicalControl(profile) ? technicalConfirmation : null,
    actor_ip: context.ipAddress,
    actor_user_agent: context.userAgent,
  });

  if (error) {
    return { ok: false, message: userFriendlyRoleError(error.message) };
  }

  revalidatePath("/admin/seguridad");
  revalidatePath("/admin");
  return { ok: true, message: active ? "Usuario reactivado correctamente." : "Usuario suspendido correctamente." };
}

export async function createOperationalUserAction(input: CreateOperationalUserInput): Promise<SecurityMutationResult> {
  const profile = await requireSession();
  const context = await requestAuditContext();

  if (!canManageUsers(profile) || !canAssignRoles(profile)) {
    await writeSecurityAudit({
      profile,
      action: "user.operational_create_blocked",
      target: null,
      newData: { result: "blocked", reason: "missing_permission", requested_role: input.role },
      context,
    });
    return { ok: false, message: "No tienes autorización para crear usuarios operativos." };
  }

  if (!operationalCreateRoles.includes(input.role)) {
    await writeSecurityAudit({
      profile,
      action: "user.operational_create_blocked",
      target: null,
      newData: { result: "blocked", reason: "role_not_operational", requested_role: input.role },
      context,
    });
    return { ok: false, message: "Solo se pueden crear usuarios operativos: vendedor, bodega, contadora o soporte." };
  }

  if (!canAssignRole(profile, input.role)) {
    await writeSecurityAudit({
      profile,
      action: "user.operational_create_blocked",
      target: null,
      newData: { result: "blocked", reason: "role_not_allowed", requested_role: input.role },
      context,
    });
    return { ok: false, message: roleErrorMessage(input.role) };
  }

  const fullName = cleanText(input.fullName);
  const username = validateUsername(input.username);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const temporaryPassword = input.temporaryPassword.trim();

  if (fullName.length < 3) {
    return { ok: false, message: "Ingresa el nombre completo del usuario." };
  }

  if (!username.ok) {
    return { ok: false, message: username.message };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "Ingresa un correo válido." };
  }

  if (phone.length < 8) {
    return { ok: false, message: "Ingresa un teléfono válido." };
  }

  if (temporaryPassword.length < 8) {
    return { ok: false, message: "La contraseña temporal debe tener al menos 8 caracteres." };
  }

  const admin = getSupabaseAdminClient();
  const [{ data: existingEmail }, { data: existingUsername }] = await Promise.all([
    admin.from("users").select("id").ilike("email", email).maybeSingle<{ id: string }>(),
    admin.from("users").select("id").eq("username", username.username).maybeSingle<{ id: string }>(),
  ]);

  if (existingEmail?.id || existingUsername?.id) {
    return { ok: false, message: "Ya existe un usuario con ese correo o nombre de usuario." };
  }

  const { data: roleRow } = await admin.from("roles").select("id").eq("name", "cliente").maybeSingle<{ id: string }>();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      username: username.username,
      phone,
    },
  });

  if (error || !data.user) {
    return { ok: false, message: error?.message ?? "No se pudo crear el usuario." };
  }

  await admin.from("users").upsert({
    id: data.user.id,
    role_id: roleRow?.id ?? null,
    full_name: fullName,
    username: username.username,
    email,
    phone,
    active: true,
    updated_at: new Date().toISOString(),
  });

  const roleResult = await changeUserRoleAction(data.user.id, input.role);
  if (!roleResult.ok) {
    return roleResult;
  }

  await writeSecurityAudit({
    profile,
    action: "user.operational_created",
    target: { id: data.user.id },
    newData: {
      result: "success",
      email,
      role: input.role,
    },
    context,
  });

  revalidatePath("/admin/seguridad");
  return { ok: true, message: `Usuario ${roleDescription(input.role)} creado correctamente.` };
}
