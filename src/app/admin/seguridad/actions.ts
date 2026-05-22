"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AppRole } from "@/types/auth";
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

const ownerAssignableRoles: AppRole[] = ["vendedor", "bodega", "contadora", "cliente"];
const adminAssignableRoles: AppRole[] = ["admin", "business_owner", "vendedor", "bodega", "contadora", "cliente"];
const operationalCreateRoles: AppRole[] = ["vendedor", "bodega", "contadora"];

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d]/g, "");
}

function userFriendlyRoleError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("no tienes autorizacion")) {
    return "No tienes autorización para asignar este rol.";
  }

  if (normalized.includes("ultimo administrador operativo")) {
    return "No puedes degradar o suspender al último administrador operativo.";
  }

  if (normalized.includes("cuenta tecnica protegida") || normalized.includes("usuarios tecnicos")) {
    return "No tienes autorización para modificar usuarios técnicos.";
  }

  return message;
}

function canAssignRole(actorRole: AppRole, targetRole: AppRole) {
  if (actorRole === "business_owner") {
    return ownerAssignableRoles.includes(targetRole);
  }

  if (actorRole === "admin") {
    return adminAssignableRoles.includes(targetRole);
  }

  if (actorRole === "technical_owner") {
    return adminAssignableRoles.includes(targetRole) || targetRole === "technical_owner";
  }

  return false;
}

function roleDescription(role: AppRole) {
  return role.replace("_", " ");
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
  const profile = await requirePermission("users:manage");

  if (!profile.permissions.includes("roles:assign") && profile.role !== "admin") {
    return { ok: false, message: "No tienes autorización para asignar este rol." };
  }

  if (!canAssignRole(profile.role, role)) {
    return { ok: false, message: "No tienes autorización para asignar este rol." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("change_user_role", {
    target_user_id: userId,
    target_role_name: role,
    change_reason: `Cambio solicitado desde /admin/seguridad por ${profile.email ?? profile.id}.`,
    technical_confirmation: null,
  });

  if (error) {
    return { ok: false, message: userFriendlyRoleError(error.message) };
  }

  revalidatePath("/admin/seguridad");
  revalidatePath("/admin");
  return { ok: true, message: "Rol actualizado correctamente." };
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<SecurityMutationResult> {
  const profile = await requirePermission("users:manage");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("set_user_active", {
    target_user_id: userId,
    next_active: active,
    change_reason: `${active ? "Reactivacion" : "Suspension"} solicitada desde /admin/seguridad por ${profile.email ?? profile.id}.`,
    technical_confirmation: null,
  });

  if (error) {
    return { ok: false, message: userFriendlyRoleError(error.message) };
  }

  revalidatePath("/admin/seguridad");
  revalidatePath("/admin");
  return { ok: true, message: active ? "Usuario reactivado correctamente." : "Usuario suspendido correctamente." };
}

export async function createOperationalUserAction(input: CreateOperationalUserInput): Promise<SecurityMutationResult> {
  const profile = await requirePermission("users:manage");

  if (!operationalCreateRoles.includes(input.role)) {
    return { ok: false, message: "Solo se pueden crear usuarios operativos: vendedor, bodega o contadora." };
  }

  if (!canAssignRole(profile.role, input.role)) {
    return { ok: false, message: "No tienes autorización para asignar este rol." };
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

  await writeAuditLog({
    tableName: "users",
    recordId: data.user.id,
    action: "user.operational_created",
    newData: {
      email,
      role: input.role,
      created_by: profile.id,
    },
  });

  revalidatePath("/admin/seguridad");
  return { ok: true, message: `Usuario ${roleDescription(input.role)} creado correctamente.` };
}
