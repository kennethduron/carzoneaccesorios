"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  DatabaseBackup,
  FileClock,
  LockKeyhole,
  Search,
  ShieldCheck,
  UserCog,
  UserPlus,
  UserX,
} from "lucide-react";
import {
  changeUserRoleAction,
  createOperationalUserAction,
  requestBackupAction,
  setUserActiveAction,
} from "@/app/admin/seguridad/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AppRole, AuthProfile } from "@/types/auth";
import type { AdminSecurityData, AdminUserSummary, BackupType } from "@/types/security";
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
  cliente: "Cliente",
};

const operationalCreateRoles: AppRole[] = ["vendedor", "bodega", "contadora"];

function formatDateTime(value: string | null) {
  return formatHnDateTime(value);
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value) {
    return "-";
  }

  return JSON.stringify(value).slice(0, 140);
}

function canAssignRole(actorRole: AppRole, role: AppRole) {
  if (actorRole === "business_owner") {
    return ["cliente", "vendedor", "bodega", "contadora"].includes(role);
  }

  if (actorRole === "admin") {
    return ["admin", "business_owner", "cliente", "vendedor", "bodega", "contadora"].includes(role);
  }

  if (actorRole === "technical_owner") {
    return ["admin", "business_owner", "cliente", "vendedor", "bodega", "contadora"].includes(role);
  }

  return false;
}

function assignableRoles(actorRole: AppRole) {
  return (Object.keys(roleLabels) as AppRole[]).filter((role) => canAssignRole(actorRole, role));
}

function canModifyUser(actorRole: AppRole, user: AdminUserSummary) {
  if (actorRole === "business_owner") {
    return ["cliente", "vendedor", "bodega", "contadora"].includes(user.role);
  }

  if (actorRole === "admin") {
    return user.role !== "technical_owner";
  }

  if (actorRole === "technical_owner") {
    return true;
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
  const [createForm, setCreateForm] = useState<CreateUserForm>(initialCreateForm);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const permissionCount = new Set(data.roles.flatMap((role) => role.permissions)).size;
  const latestBackup = data.backupLogs[0];
  const canManageUsers = currentUser.role === "admin" || currentUser.permissions.includes("users:manage");
  const canRequestBackups = currentUser.role === "admin" || currentUser.permissions.includes("settings:manage");
  const roleOptions = assignableRoles(currentUser.role);
  const selectedAuditUser = data.users.find((user) => user.id === auditUserId) ?? null;
  const visibleAuditLogs = selectedAuditUser
    ? data.auditLogs.filter((log) => log.user_id === selectedAuditUser.id || log.record_id === selectedAuditUser.id)
    : data.auditLogs;

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
                <InputLabel label="Telefono">
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
                <InputLabel label="Contrasena temporal">
                  <input
                    value={createForm.temporaryPassword}
                    onChange={(event) => updateCreateForm("temporaryPassword", event.target.value)}
                    className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                    type="password"
                    minLength={8}
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
                <h2 className="font-semibold">Gestion de usuarios</h2>
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
              <table className="w-full min-w-[1160px] text-left text-sm">
                <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                  <tr>
                    <th className="px-4 py-3">Usuario</th>
                    <th className="px-4 py-3">Rol</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3">Creacion</th>
                    <th className="px-4 py-3">Ultimo acceso</th>
                    <th className="px-4 py-3">Correo</th>
                    <th className="px-4 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {filteredUsers.map((user) => {
                    const selectedRole = roleSelections[user.id] ?? user.role;
                    const canModify = canModifyUser(currentUser.role, user);
                    const canChangeToSelected = canAssignRole(currentUser.role, selectedRole);

                    return (
                      <tr key={user.id}>
                        <td className="px-4 py-3">
                          <p className="font-semibold">{user.full_name || user.email || "Sin nombre"}</p>
                          <p className="text-xs text-black/50">{user.email ?? "-"}</p>
                          <p className="text-xs text-black/40">{user.username ? `@${user.username}` : user.id.slice(0, 8)}</p>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={selectedRole}
                            onChange={(event) =>
                              setRoleSelections((current) => ({ ...current, [user.id]: event.target.value as AppRole }))
                            }
                            className="w-44 rounded-md border border-black/10 bg-white px-2 py-2 text-sm outline-none"
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
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                              user.active ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#fdecec] text-[#a33a2d]"
                            }`}
                          >
                            {user.active ? "Activo" : "Suspendido"}
                          </span>
                        </td>
                        <td className="px-4 py-3">{formatDateTime(user.created_at)}</td>
                        <td className="px-4 py-3">{formatDateTime(user.last_sign_in_at)}</td>
                        <td className="px-4 py-3">
                          {user.email_confirmed_at ? (
                            <span className="inline-flex items-center gap-1 text-[#2f6f3e]">
                              <CheckCircle2 size={15} />
                              Confirmado
                            </span>
                          ) : (
                            <span className="text-black/45">Pendiente</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={!canModify || !canChangeToSelected || selectedRole === user.role || isPending}
                              onClick={() => openRoleChange(user)}
                            >
                              Asignar rol
                            </Button>
                            <Button
                              type="button"
                              variant={user.active ? "ghost" : "secondary"}
                              disabled={!canModify || isPending}
                              onClick={() => setActive(user, !user.active)}
                            >
                              {user.active ? <UserX size={16} /> : <CheckCircle2 size={16} />}
                              {user.active ? "Suspender" : "Reactivar"}
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => setAuditUserId(user.id)}>
                              Ver auditoria
                            </Button>
                            {user.customer_id ? (
                              <Link
                                href={`/admin/clientes?customerId=${encodeURIComponent(user.customer_id)}`}
                                className="inline-flex items-center rounded-md border border-black/10 px-3 py-2 text-sm font-semibold"
                              >
                                Ver perfil
                              </Link>
                            ) : null}
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
                <p className="font-medium text-[#080808]">Ultimo respaldo</p>
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
            <ControlItem title="Rutas protegidas" description="/admin pasa por proxy y cada pagina revalida permisos en servidor." />
            <ControlItem title="Cambios de rol" description="Solo se ejecutan mediante RPC con auditoria y reglas de ultimo administrador." />
            <ControlItem title="Technical owner" description="Usuarios tecnicos no pueden ser modificados por roles operativos." />
            <ControlItem title="Usuarios suspendidos" description="active=false invalida acceso al panel y al inicio de sesion." />
            <ControlItem title="RLS Supabase" description="Las politicas limitan lectura y escritura por rol y propietario." />
            <ControlItem title="Secretos" description="La UI no muestra API keys, CRON_SECRET ni variables de integraciones." />
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

      <section className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title={selectedAuditUser ? `Auditoria de ${selectedAuditUser.email ?? selectedAuditUser.full_name}` : "Audit logs"}
          icon={<FileClock size={19} />}
          columns={["Fecha", "Usuario", "Rol", "Tabla", "Accion", "Datos"]}
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

      {roleDraft ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Cambiar rol de usuario</h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              Esta accion modificara el acceso de este usuario al sistema. Verifica que el rol seleccionado sea correcto.
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
