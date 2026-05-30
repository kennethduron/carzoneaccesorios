"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  DatabaseBackup,
  Eye,
  FileClock,
  LockKeyhole,
  Search,
  ShieldCheck,
  UserCog,
  UserPlus,
  UserRound,
  UserX,
} from "lucide-react";
import {
  changeUserRoleAction,
  createOperationalUserAction,
  requestBackupAction,
  setUserActiveAction,
} from "@/app/admin/seguridad/actions";
import { Button } from "@/components/ui";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/contexts/toast-context";
import type { AppRole, AuthProfile } from "@/types/auth";
import type { AdminSecurityData, AdminUserSummary, AuditLogRow, BackupType } from "@/types/security";
import { formatHnDateTime } from "@/utils/format";

type SecurityCenterProps = {
  data: AdminSecurityData;
  currentUser: AuthProfile;
};

type RoleChangeDraft = {
  user: AdminUserSummary;
  role: AppRole;
} | null;

type CreateUserForm = {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  role: AppRole;
  temporaryPassword: string;
};

type AuditPeriod = "today" | "yesterday" | "7d" | "month" | "custom" | "all";

type AuditFilters = {
  period: AuditPeriod;
  module: string;
  action: string;
  severity: string;
  from: string;
  to: string;
};

const backupTypeLabels: Record<BackupType, string> = {
  manual: "Manual",
  scheduled: "Programado",
  pre_deploy: "Antes de deploy",
};

const roleLabels: Record<AppRole, string> = {
  technical_owner: "Technical owner",
  admin: "Admin",
  business_owner: "Dueño operativo",
  vendedor: "Vendedor",
  bodega: "Bodega",
  contadora: "Contadora",
  soporte: "Soporte",
  cliente: "Cliente",
};

const operationalCreateRoles: AppRole[] = ["vendedor", "bodega", "contadora", "soporte"];
const operationalManageRoles: AppRole[] = ["cliente", "vendedor", "bodega", "contadora", "soporte"];
const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
const sensitiveKeyPattern = /(password|token|secret|apikey|api_key|key|service_role|authorization|card|tarjeta|cron_secret)/i;

const roleDescriptions: Record<AppRole, string> = {
  technical_owner: "Administrador técnico. Mantiene infraestructura, monitoreo y recuperación técnica.",
  admin: "Administrador técnico/avanzado. Puede operar el sistema y administrar configuración sensible.",
  business_owner: "Dueño operativo. Administra ventas, equipo, pedidos, clientes, pagos, facturas y reportes sin secretos técnicos.",
  vendedor: "Atiende clientes, pedidos y CRM operativo.",
  bodega: "Gestiona inventario, preparación y envíos.",
  contadora: "Revisa pagos, facturas, fiscal y reportes financieros.",
  soporte: "Atiende soporte, consultas de clientes y seguimiento operativo limitado.",
  cliente: "Cuenta pública de compra y consulta de sus propios pedidos.",
};

function formatDateTime(value: string | null) {
  return formatHnDateTime(value);
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value) {
    return "-";
  }

  return JSON.stringify(maskSensitiveValue(value)).slice(0, 180);
}

function maskSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskSensitiveValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[oculto]" : maskSensitiveValue(entry),
      ]),
    );
  }

  return value;
}

function auditModule(log: Pick<AuditLogRow, "table_name" | "action">) {
  const action = log.action.toLowerCase();
  const table = log.table_name;

  if (action.includes("product") || table.includes("product")) return "Productos";
  if (action.includes("inventory") || table.includes("inventory")) return "Inventario";
  if (action.includes("payment") || table === "payments") return "Pagos";
  if (action.includes("invoice") || action.includes("fiscal") || table.includes("invoice")) return "Facturación";
  if (action.includes("crm") || table.includes("crm")) return "CRM";
  if (action.includes("wholesale")) return "Mayoreo";
  if (action.includes("user") || table === "users" || table === "roles") return "Usuarios y roles";
  if (action.includes("settings") || table.includes("settings")) return "Configuración";
  if (action.includes("order") || table === "orders") return "Pedidos";
  return table;
}

function auditSeverity(log: Pick<AuditLogRow, "action">) {
  const action = log.action.toLowerCase();
  if (action.includes("failed") || action.includes("error") || action.includes("deleted") || action.includes("suspended")) return "warning";
  if (action.includes("role_changed") || action.includes("settings") || action.includes("cancel") || action.includes("rejected")) return "review";
  return "info";
}

function auditResult(log: Pick<AuditLogRow, "action" | "new_data">) {
  const action = log.action.toLowerCase();
  const status = String(log.new_data?.status ?? log.new_data?.result ?? "").toLowerCase();
  if (action.includes("failed") || action.includes("error") || action.includes("blocked") || status.includes("failed")) {
    return "Fallido";
  }

  return "Exitoso";
}

function isWithinPeriod(logDate: Date, filters: AuditFilters) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  if (filters.period === "today") {
    return logDate >= startOfToday && logDate < startOfTomorrow;
  }

  if (filters.period === "yesterday") {
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    return logDate >= startOfYesterday && logDate < startOfToday;
  }

  if (filters.period === "7d") {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    return logDate >= cutoff;
  }

  if (filters.period === "month") {
    return logDate >= new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (filters.period === "custom") {
    const from = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const to = filters.to ? new Date(`${filters.to}T23:59:59`) : null;
    return (!from || logDate >= from) && (!to || logDate <= to);
  }

  return true;
}

function deviceLabel(userAgent: string | null) {
  if (!userAgent) return "-";
  if (userAgent.length <= 80) return userAgent;
  return `${userAgent.slice(0, 80)}...`;
}

function hasTechnicalControl(profile: Pick<AuthProfile, "role" | "email">) {
  return profile.role === "technical_owner" || profile.email?.toLowerCase() === protectedTechnicalEmail;
}

function canAssignRole(actor: Pick<AuthProfile, "role" | "email">, role: AppRole) {
  if (hasTechnicalControl(actor)) {
    return ["technical_owner", "admin", "business_owner", "cliente", "vendedor", "bodega", "contadora", "soporte"].includes(role);
  }

  if (actor.role === "business_owner") {
    return operationalManageRoles.includes(role);
  }

  if (actor.role === "admin") {
    return ["admin", "business_owner", "cliente", "vendedor", "bodega", "contadora", "soporte"].includes(role);
  }

  return false;
}

function assignableRoles(actor: Pick<AuthProfile, "role" | "email">) {
  return (Object.keys(roleLabels) as AppRole[]).filter((role) => canAssignRole(actor, role));
}

function canModifyUser(actor: Pick<AuthProfile, "role" | "email">, user: AdminUserSummary) {
  const isProtectedTechnicalUser = user.email?.toLowerCase() === protectedTechnicalEmail || user.role === "technical_owner";

  if (hasTechnicalControl(actor)) {
    return true;
  }

  if (actor.role === "business_owner") {
    return !isProtectedTechnicalUser && operationalManageRoles.includes(user.role);
  }

  if (actor.role === "admin") {
    return !isProtectedTechnicalUser;
  }

  return false;
}

function initialCreateForm(): CreateUserForm {
  return {
    fullName: "",
    username: "",
    email: "",
    phone: "",
    role: "vendedor",
    temporaryPassword: "",
  };
}

export function SecurityCenter({ data, currentUser }: SecurityCenterProps) {
  const [backupType, setBackupType] = useState<BackupType>("manual");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [roleSelections, setRoleSelections] = useState<Record<string, AppRole>>({});
  const [roleDraft, setRoleDraft] = useState<RoleChangeDraft>(null);
  const [auditUserId, setAuditUserId] = useState<string | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({
    period: "7d",
    module: "all",
    action: "all",
    severity: "all",
    from: "",
    to: "",
  });
  const [createForm, setCreateForm] = useState<CreateUserForm>(initialCreateForm);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const permissionCount = new Set(data.roles.flatMap((role) => role.permissions)).size;
  const latestBackup = data.backupLogs[0];
  const canManageUsers =
    hasTechnicalControl(currentUser) ||
    currentUser.role === "admin" ||
    currentUser.permissions.includes("users:manage") ||
    currentUser.permissions.includes("users:manage_operational");
  const canRequestBackups =
    hasTechnicalControl(currentUser) ||
    (currentUser.role === "admin" && currentUser.permissions.includes("settings:manage"));
  const roleOptions = assignableRoles(currentUser);
  const selectedAuditUser = data.users.find((user) => user.id === auditUserId) ?? null;
  const selectedProfileUser = data.users.find((user) => user.id === profileUserId) ?? null;
  const auditModules = Array.from(new Set(data.auditLogs.map(auditModule))).sort((left, right) => left.localeCompare(right, "es-HN"));
  const auditActions = Array.from(new Set(data.auditLogs.map((log) => log.action))).sort((left, right) => left.localeCompare(right, "es-HN"));
  const visibleAuditLogs = (selectedAuditUser
    ? data.auditLogs.filter((log) => log.user_id === selectedAuditUser.id || log.record_id === selectedAuditUser.id)
    : data.auditLogs
  ).filter((log) => {
    const logDate = new Date(log.created_at);
    return (
      isWithinPeriod(logDate, auditFilters) &&
      (auditFilters.module === "all" || auditModule(log) === auditFilters.module) &&
      (auditFilters.action === "all" || log.action === auditFilters.action) &&
      (auditFilters.severity === "all" || auditSeverity(log) === auditFilters.severity)
    );
  });

  const filteredUsers = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return data.users;
    }

    return data.users.filter((user) =>
      [user.full_name, user.email, user.username, user.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized)),
    );
  }, [data.users, search]);

  function requestBackup() {
    startTransition(async () => {
      const result = await requestBackupAction(backupType, notes);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Backup solicitado correctamente.");
        setNotes("");
      } else {
        toast.error(result.message || "No se pudo solicitar el backup.");
      }
    });
  }

  function openRoleChange(user: AdminUserSummary) {
    const role = roleSelections[user.id] ?? user.role;
    setRoleDraft({ user, role });
  }

  function confirmRoleChange() {
    if (!roleDraft) {
      return;
    }

    startTransition(async () => {
      const result = await changeUserRoleAction(roleDraft.user.id, roleDraft.role);
      if (result.ok) {
        toast.success(result.message || "Rol actualizado correctamente.");
        setRoleDraft(null);
      } else {
        toast.error(result.message || "No tienes autorización para asignar este rol.");
      }
    });
  }

  function setActive(user: AdminUserSummary, active: boolean) {
    startTransition(async () => {
      const result = await setUserActiveAction(user.id, active);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createOperationalUserAction(createForm);
      if (result.ok) {
        toast.success(result.message);
        setCreateForm(initialCreateForm());
      } else {
        toast.error(result.message);
      }
    });
  }

  function updateCreateForm<K extends keyof CreateUserForm>(key: K, value: CreateUserForm[K]) {
    setCreateForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Usuarios" value={data.users.length.toLocaleString("es-HN")} />
        <Metric label="Roles activos" value={data.roles.length.toLocaleString("es-HN")} />
        <Metric label="Permisos" value={permissionCount.toLocaleString("es-HN")} />
        <Metric label="Logs recientes" value={data.auditLogs.length.toLocaleString("es-HN")} />
      </div>

      <section className="grid gap-3 lg:grid-cols-3">
        <ControlItem
          title="Perfil de usuario"
          description="Muestra datos de cuenta, rol, estado, módulos permitidos y relación comercial como cliente, pedidos y facturas."
        />
        <ControlItem
          title="Actividad / auditoría"
          description="Muestra acciones realizadas en el sistema, con filtros por fecha, módulo, acción y severidad."
        />
        <ControlItem
          title="Separación técnica"
          description="El dueño operativo no recibe secretos, errores crudos, backups ni módulos de infraestructura."
        />
      </section>

      {canManageUsers ? (
        <section className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
          <form onSubmit={createUser} className="rounded-lg border border-black/10 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <UserPlus size={19} />
              <h2 className="font-semibold">Crear usuario operativo</h2>
            </div>
            <div className="grid gap-3">
              <InputLabel label="Nombre">
                <input
                  value={createForm.fullName}
                  onChange={(event) => updateCreateForm("fullName", event.target.value)}
                  className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                  required
                />
              </InputLabel>
              <InputLabel label="Usuario">
                <input
                  value={createForm.username}
                  onChange={(event) => updateCreateForm("username", event.target.value)}
                  className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                  minLength={3}
                  maxLength={30}
                  required
                />
              </InputLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                <InputLabel label="Correo">
                  <input
                    value={createForm.email}
                    onChange={(event) => updateCreateForm("email", event.target.value)}
                    className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                    type="email"
                    required
                  />
                </InputLabel>
                <InputLabel label="Teléfono">
                  <input
                    value={createForm.phone}
                    onChange={(event) => updateCreateForm("phone", event.target.value)}
                    className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                    required
                  />
                </InputLabel>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <InputLabel label="Rol">
                  <select
                    value={createForm.role}
                    onChange={(event) => updateCreateForm("role", event.target.value as AppRole)}
                    className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                  >
                    {operationalCreateRoles.map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </InputLabel>
                <InputLabel label="Contraseña temporal">
                  <PasswordInput
                    value={createForm.temporaryPassword}
                    onChange={(event) => updateCreateForm("temporaryPassword", event.target.value)}
                    minLength={8}
                    autoComplete="new-password"
                    required
                  />
                </InputLabel>
              </div>
              <Button type="submit" variant="dark" disabled={isPending}>
                <UserPlus size={17} />
                Crear usuario
              </Button>
            </div>
          </form>

          <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
            <div className="flex flex-col gap-3 border-b border-black/10 p-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-2">
                <UserCog size={19} />
                <h2 className="font-semibold">Gestión de usuarios</h2>
              </div>
              <label className="relative block w-full lg:max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-2.5 text-black/40" size={17} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full rounded-md border border-black/10 py-2 pl-9 pr-3 text-sm outline-none"
                  placeholder="Buscar por nombre, correo o rol"
                />
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] table-fixed text-left text-sm">
                <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                  <tr>
                    <th className="w-[23%] px-4 py-3">Usuario</th>
                    <th className="w-[15%] px-4 py-3">Rol</th>
                    <th className="w-[11%] px-4 py-3">Estado</th>
                    <th className="px-4 py-3">Creación</th>
                    <th className="px-4 py-3">Último acceso</th>
                    <th className="w-[11%] px-4 py-3">Correo</th>
                    <th className="w-[16%] px-3 py-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {filteredUsers.map((user) => {
                    const selectedRole = roleSelections[user.id] ?? user.role;
                    const canModify = canModifyUser(currentUser, user);
                    const canChangeToSelected = canAssignRole(currentUser, selectedRole);

                    return (
                      <tr key={user.id}>
                        <td className="px-4 py-3 align-top">
                          <p className="truncate font-semibold">{user.full_name || user.email || "Sin nombre"}</p>
                          <p className="truncate text-xs text-black/50">{user.email ?? "-"}</p>
                          <p className="text-xs text-black/40">{user.username ? `@${user.username}` : user.id.slice(0, 8)}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <select
                            value={selectedRole}
                            onChange={(event) =>
                              setRoleSelections((current) => ({ ...current, [user.id]: event.target.value as AppRole }))
                            }
                            className="w-full rounded-md border border-black/10 bg-white px-2 py-2 text-sm outline-none"
                            disabled={!canModify}
                          >
                            {roleOptions.map((role) => (
                              <option key={role} value={role}>
                                {roleLabels[role]}
                              </option>
                            ))}
                            {!roleOptions.includes(user.role) ? (
                              <option value={user.role}>{roleLabels[user.role]}</option>
                            ) : null}
                          </select>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                              user.active ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#fdecec] text-[#a33a2d]"
                            }`}
                          >
                            {user.active ? "Activo" : "Suspendido"}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-xs text-black/65">{formatDateTime(user.created_at)}</td>
                        <td className="px-4 py-3 align-top text-xs text-black/65">{formatDateTime(user.last_sign_in_at)}</td>
                        <td className="px-4 py-3 align-top">
                          {user.email_confirmed_at ? (
                            <span className="inline-flex items-center gap-1 text-[#2f6f3e]">
                              <CheckCircle2 size={15} />
                              Confirmado
                            </span>
                          ) : (
                            <span className="text-black/45">Pendiente</span>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex justify-end gap-1">
                            <IconActionButton
                              label="Asignar rol"
                              disabled={!canModify || !canChangeToSelected || selectedRole === user.role || isPending}
                              onClick={() => openRoleChange(user)}
                            >
                              <ShieldCheck size={15} />
                            </IconActionButton>
                            <IconActionButton
                              label={user.active ? "Suspender usuario" : "Reactivar usuario"}
                              disabled={!canModify || isPending}
                              onClick={() => setActive(user, !user.active)}
                            >
                              {user.active ? <UserX size={15} /> : <CheckCircle2 size={15} />}
                            </IconActionButton>
                            <IconActionButton label="Ver actividad" onClick={() => setAuditUserId(user.id)}>
                              <FileClock size={15} />
                            </IconActionButton>
                            <IconActionButton label="Ver perfil del usuario" onClick={() => setProfileUserId(user.id)}>
                              <Eye size={15} />
                            </IconActionButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      ) : null}

      <section className={`grid gap-5 ${canRequestBackups ? "xl:grid-cols-[420px_1fr]" : ""}`}>
        {canRequestBackups ? (
          <div className="rounded-lg border border-black/10 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <DatabaseBackup size={19} />
              <h2 className="font-semibold">Backups</h2>
            </div>
            <div className="grid gap-3">
              <InputLabel label="Tipo">
                <select
                  value={backupType}
                  onChange={(event) => setBackupType(event.target.value as BackupType)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
                >
                  {Object.entries(backupTypeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </InputLabel>
              <InputLabel label="Notas">
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                  placeholder="Motivo del respaldo"
                />
              </InputLabel>
              <Button onClick={requestBackup} disabled={isPending} variant="dark">
                <DatabaseBackup size={17} />
                {isPending ? "Registrando..." : "Solicitar backup"}
              </Button>
              {message ? <p className="text-sm text-black/60">{message}</p> : null}
              <div className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/65">
                <p className="font-medium text-[#080808]">Último respaldo</p>
                <p>{latestBackup ? `${backupTypeLabels[latestBackup.backup_type]} / ${latestBackup.status}` : "Sin registros"}</p>
                <p>{latestBackup ? formatDateTime(latestBackup.created_at) : "-"}</p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={19} />
            <h2 className="font-semibold">Controles activos</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ControlItem title="Rutas protegidas" description="/admin pasa por proxy y cada página revalida permisos en servidor." />
            <ControlItem title="Cambios de rol" description="Solo se ejecutan mediante RPC con auditoría y reglas de último administrador." />
            <ControlItem title="Cuenta protegida" description="Las cuentas protegidas no pueden ser modificadas por roles operativos." />
            <ControlItem title="Usuarios suspendidos" description="active=false invalida acceso al panel y al inicio de sesión." />
            <ControlItem title="RLS Supabase" description="Las politicas limitan lectura y escritura por rol y propietario." />
            <ControlItem title="Secretos" description="La UI no muestra API keys, secretos de cron ni variables de integraciones." />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="flex items-center gap-2 border-b border-black/10 p-5">
          <LockKeyhole size={19} />
          <h2 className="font-semibold">Roles y permisos</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Permisos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {data.roles.map((role) => (
                <tr key={role.role}>
                  <td className="px-4 py-3 font-semibold">{roleLabels[role.role]}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {role.permissions.map((permission) => (
                        <span key={permission} className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs">
                          {permission}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`grid gap-5 ${data.backupLogs.length > 0 || canRequestBackups ? "xl:grid-cols-2" : ""}`}>
        <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
          <div className="flex flex-col gap-3 border-b border-black/10 p-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <FileClock size={19} />
                <h2 className="font-semibold">
                  {selectedAuditUser ? `Actividad de ${selectedAuditUser.email ?? selectedAuditUser.full_name}` : "Actividad y auditoría"}
                </h2>
              </div>
              <p className="mt-1 text-sm text-black/55">Consulta las acciones realizadas por este usuario en el sistema.</p>
            </div>
            {selectedAuditUser ? (
              <Button type="button" variant="ghost" onClick={() => setAuditUserId(null)}>
                Ver todo
              </Button>
            ) : null}
          </div>

          <div className="grid gap-3 border-b border-black/10 p-4 md:grid-cols-3 xl:grid-cols-6">
            <InputLabel label="Fecha">
              <select
                value={auditFilters.period}
                onChange={(event) => setAuditFilters((current) => ({ ...current, period: event.target.value as AuditPeriod }))}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="today">Hoy</option>
                <option value="yesterday">Ayer</option>
                <option value="7d">Últimos 7 días</option>
                <option value="month">Este mes</option>
                <option value="custom">Rango personalizado</option>
                <option value="all">Todo</option>
              </select>
            </InputLabel>
            <InputLabel label="Módulo">
              <select
                value={auditFilters.module}
                onChange={(event) => setAuditFilters((current) => ({ ...current, module: event.target.value }))}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="all">Todos</option>
                {auditModules.map((module) => (
                  <option key={module} value={module}>
                    {module}
                  </option>
                ))}
              </select>
            </InputLabel>
            <InputLabel label="Acción">
              <select
                value={auditFilters.action}
                onChange={(event) => setAuditFilters((current) => ({ ...current, action: event.target.value }))}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="all">Todas</option>
                {auditActions.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </InputLabel>
            <InputLabel label="Severidad">
              <select
                value={auditFilters.severity}
                onChange={(event) => setAuditFilters((current) => ({ ...current, severity: event.target.value }))}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="all">Todas</option>
                <option value="info">Informativa</option>
                <option value="review">Revisión</option>
                <option value="warning">Alerta</option>
              </select>
            </InputLabel>
            <InputLabel label="Desde">
              <input
                type="date"
                value={auditFilters.from}
                onChange={(event) => setAuditFilters((current) => ({ ...current, period: "custom", from: event.target.value }))}
                className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </InputLabel>
            <InputLabel label="Hasta">
              <input
                type="date"
                value={auditFilters.to}
                onChange={(event) => setAuditFilters((current) => ({ ...current, period: "custom", to: event.target.value }))}
                className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </InputLabel>
          </div>

          <div className="max-h-[650px] overflow-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                <tr>
                  {["Fecha/hora", "Usuario", "Rol", "Módulo", "Acción", "Entidad", "Resultado", "IP", "Navegador", "Cambios"].map((column) => (
                    <th key={column} className="sticky top-0 z-10 bg-[#e7e5e4] px-4 py-3">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {visibleAuditLogs.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-center text-black/50" colSpan={10}>
                      Sin registros para los filtros seleccionados.
                    </td>
                  </tr>
                ) : (
                  visibleAuditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="px-4 py-3">{formatDateTime(log.created_at)}</td>
                      <td className="px-4 py-3">{log.user_name ?? log.user_email ?? "Sistema"}</td>
                      <td className="px-4 py-3">{log.actor_role ?? "-"}</td>
                      <td className="px-4 py-3">{auditModule(log)}</td>
                      <td className="px-4 py-3">{log.action}</td>
                      <td className="px-4 py-3">{log.record_id ? `${log.table_name}:${log.record_id.slice(0, 8)}` : log.table_name}</td>
                      <td className="px-4 py-3">{auditResult(log)}</td>
                      <td className="px-4 py-3">{log.ip_address ?? "-"}</td>
                      <td className="px-4 py-3">{deviceLabel(log.user_agent)}</td>
                      <td className="px-4 py-3">
                        <span className="block text-xs text-black/50">Antes: {compactJson(log.old_data)}</span>
                        <span className="block text-xs text-black/70">Nuevo: {compactJson(log.new_data)}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {data.backupLogs.length > 0 || canRequestBackups ? (
          <DataTable
            title="Historial de backups"
            icon={<DatabaseBackup size={19} />}
            columns={["Fecha", "Tipo", "Estado", "Solicitado por", "Notas"]}
            rows={data.backupLogs.map((backup) => [
              formatDateTime(backup.created_at),
              backupTypeLabels[backup.backup_type],
              backup.status,
              backup.requested_by_email ?? "Sistema",
              backup.notes ?? "-",
            ])}
          />
        ) : null}
      </section>

      <section className="hidden">
        <DataTable
          title={selectedAuditUser ? `Auditoria de ${selectedAuditUser.email ?? selectedAuditUser.full_name}` : "Audit logs"}
          icon={<FileClock size={19} />}
          columns={["Fecha", "Usuario", "Rol", "Tabla", "Acción", "Datos"]}
          action={
            selectedAuditUser ? (
              <Button type="button" variant="ghost" onClick={() => setAuditUserId(null)}>
                Ver todo
              </Button>
            ) : null
          }
          rows={visibleAuditLogs.map((log) => [
            formatDateTime(log.created_at),
            log.user_name ?? log.user_email ?? "Sistema",
            log.actor_role ?? "-",
            log.table_name,
            log.action,
            compactJson(log.new_data),
          ])}
        />
        <DataTable
          title="Historial de backups"
          icon={<DatabaseBackup size={19} />}
          columns={["Fecha", "Tipo", "Estado", "Solicitado por", "Notas"]}
          rows={data.backupLogs.map((backup) => [
            formatDateTime(backup.created_at),
            backupTypeLabels[backup.backup_type],
            backup.status,
            backup.requested_by_email ?? "Sistema",
            backup.notes ?? "-",
          ])}
        />
      </section>

      {selectedProfileUser ? (
        <UserProfileModal
          user={selectedProfileUser}
          rolePermissions={data.roles.find((role) => role.role === selectedProfileUser.role)?.permissions ?? []}
          onClose={() => setProfileUserId(null)}
          onViewActivity={() => {
            setAuditUserId(selectedProfileUser.id);
            setProfileUserId(null);
          }}
        />
      ) : null}

      {roleDraft ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Cambiar rol de usuario</h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              Esta acción modificará el acceso de este usuario al sistema. Verifica que el rol seleccionado sea correcto.
            </p>
            <div className="mt-4 rounded-md bg-[#f4f4f5] p-3 text-sm">
              <p className="font-semibold">{roleDraft.user.full_name || roleDraft.user.email}</p>
              <p className="text-black/55">{roleDraft.user.email}</p>
              <p className="mt-2">
                {roleLabels[roleDraft.user.role]} {"->"} <span className="font-semibold">{roleLabels[roleDraft.role]}</span>
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRoleDraft(null)} disabled={isPending}>
                Cancelar
              </Button>
              <Button type="button" variant="dark" onClick={confirmRoleChange} disabled={isPending}>
                Confirmar cambio
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IconActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-grid size-7 place-items-center rounded-md border border-black/10 bg-white text-black/70 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] hover:text-[#b91c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-black/5 disabled:text-black/25 disabled:hover:translate-y-0"
    >
      {children}
    </button>
  );
}

function UserProfileModal({
  user,
  rolePermissions,
  onClose,
  onViewActivity,
}: {
  user: AdminUserSummary;
  rolePermissions: string[];
  onClose: () => void;
  onViewActivity: () => void;
}) {
  const isClient = user.role === "cliente";
  const isInternal = user.profile_kind === "internal";

  return (
    <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 p-4">
      <section className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex flex-col gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <UserRound size={20} />
              <h2 className="text-lg font-semibold">Perfil del usuario</h2>
            </div>
            <p className="mt-1 text-sm text-black/55">
              {isClient ? "Perfil de cliente: cuenta, pedidos, facturas e historial de compras." : "Perfil operativo: rol, estado, acceso, módulos permitidos y auditoría."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-[#fff1f2] px-2 py-1 font-semibold text-[#b91c25]">{user.profile_label}</span>
              {isInternal ? <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-black/60">Usuario interno</span> : null}
            </div>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <InfoCard label="Nombre" value={user.full_name ?? "Sin nombre"} />
          <InfoCard label="Usuario" value={user.username ? `@${user.username}` : "-"} />
          <InfoCard label="Correo" value={user.email ?? "-"} />
          <InfoCard label="Teléfono" value={user.phone ?? "-"} />
          <InfoCard label="Rol actual" value={roleLabels[user.role]} />
          <InfoCard label="Estado de cuenta" value={user.active ? "Activa" : "Suspendida"} />
          <InfoCard label="Último acceso" value={formatDateTime(user.last_sign_in_at)} />
          <InfoCard label="Fecha de creación" value={formatDateTime(user.created_at)} />
        </div>

        {isClient || user.customer_id ? (
          <div className="mt-5 rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
            <h3 className="font-semibold">{isInternal ? "Compras personales vinculadas" : "Información de cliente"}</h3>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              {!isInternal ? <InfoCard label="Negocio/contacto" value={user.customer_business_name ?? user.full_name ?? "-"} compact /> : null}
              {!isInternal ? <InfoCard label="Estado cliente" value={user.customer_status ?? "-"} compact /> : null}
              {!isInternal ? <InfoCard label="Mayoreo" value={user.customer_wholesale_status ?? "Sin solicitud"} compact /> : null}
              {!isInternal ? <InfoCard label="Solicitudes mayoristas" value={String(user.wholesale_request_count)} compact /> : null}
              <InfoCard label="Pedidos" value={String(user.order_count)} compact />
              <InfoCard label="Facturas" value={String(user.invoice_count)} compact />
              <InfoCard label={isInternal ? "Compras personales" : "Historial de compras"} value={user.recent_orders.length > 0 ? "Con compras registradas" : "Sin compras"} compact />
            </div>
            {user.customer_id && !isInternal ? (
              <Link
                href={`/admin/clientes?customerId=${encodeURIComponent(user.customer_id)}`}
                className="mt-4 inline-flex rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold"
              >
                Abrir perfil de cliente en CRM
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 rounded-lg border border-black/10 bg-white p-4">
          <h3 className="font-semibold">Módulos permitidos</h3>
          <p className="mt-1 text-sm text-black/55">{roleDescriptions[user.role]}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {rolePermissions.length === 0 ? (
              <span className="text-sm text-black/50">Sin permisos operativos registrados.</span>
            ) : (
              rolePermissions.map((permission) => (
                <span key={permission} className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs">
                  {permission}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-black/10 bg-white p-4">
          <h3 className="font-semibold">Pedidos recientes</h3>
          <div className="mt-3 space-y-2">
            {user.recent_orders.length === 0 ? (
              <p className="text-sm text-black/50">Sin pedidos recientes.</p>
            ) : (
              user.recent_orders.map((order) => (
                <div key={order.id} className="flex flex-col gap-1 rounded-md bg-[#f4f4f5] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-semibold">{order.order_number}</span>
                  <span>{order.status}</span>
                  <span>{order.price_mode === "wholesale" ? "Mayorista" : "Detalle"}</span>
                  <span>{formatDateTime(order.created_at)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onViewActivity}>
            <FileClock size={16} />
            Ver actividad
          </Button>
          <Button type="button" variant="dark" onClick={onClose}>
            Listo
          </Button>
        </div>
      </section>
    </div>
  );
}

function InfoCard({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-md border border-black/10 bg-white ${compact ? "p-3" : "p-4"}`}>
      <p className="text-xs font-medium uppercase text-black/45">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function InputLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function ControlItem({ title, description }: { title: string; description: string }) {
  return (
    <article className="rounded-md bg-[#f4f4f5] p-3">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-black/60">{description}</p>
    </article>
  );
}

function DataTable({
  title,
  icon,
  columns,
  rows,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  columns: string[];
  rows: string[][];
  action?: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-black/10 p-5">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              {columns.map((column) => (
                <th key={column} className="px-4 py-3">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-black/50" colSpan={columns.length}>
                  Sin registros.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={`${title}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${title}-${index}-${cellIndex}`} className="px-4 py-3">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
