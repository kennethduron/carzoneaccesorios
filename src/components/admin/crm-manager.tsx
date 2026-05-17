"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  MessageSquarePlus,
  PackageSearch,
  PhoneCall,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  archiveCrmNoteAction,
  approveWholesaleRequestAction,
  deleteTestAccountAction,
  getCustomerProfileAction,
  mergeDuplicateCustomerAction,
  reactivateCustomerAccountAction,
  saveCrmFollowupAction,
  saveCrmLeadAction,
  saveCrmNoteAction,
  setCrmFollowupStatusAction,
  suspendCustomerAccountAction,
} from "@/app/admin/crm/actions";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type {
  AdminCrmData,
  CrmCustomerOption,
  CrmCustomerProfile,
  CrmDuplicateCandidate,
  CrmDuplicateGroup,
  CrmFollowupInput,
  CrmFollowupRow,
  CrmInteractionType,
  CrmLeadInput,
  CrmLeadStatus,
  CrmNoteInput,
  CrmNoteRow,
  CrmPriority,
} from "@/types/crm";
import { formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

type CrmManagerProps = {
  data: AdminCrmData;
  basePath?: string;
  focus?: "customers" | "followups";
};

type CustomerFilter = "all" | "active" | "prospects" | "wholesale" | "wholesale_requests" | "suspended";

type DuplicateMergeRequest = {
  source: CrmDuplicateCandidate;
  target: CrmDuplicateCandidate;
};

type CrmDrawerMode = "lead" | "followup" | "note" | "followup-detail" | null;

const interactionLabels: Record<CrmInteractionType, string> = {
  seguimiento: "Seguimiento",
  llamada: "Llamada",
  nota: "Nota",
  reunion: "Reunión",
  prospecto: "Prospecto",
  contacto_general: "Contacto general",
  solicitud_mayorista: "Solicitud mayorista",
};

const priorityLabels: Record<CrmPriority, string> = {
  baja: "Baja",
  media: "Media",
  alta: "Alta",
  urgente: "Urgente",
};

const leadStatusLabels: Record<CrmLeadStatus, string> = {
  prospecto: "Prospecto",
  contactado: "Contactado",
  calificado: "Calificado",
  cliente: "Cliente",
  perdido: "Perdido",
};

const customerFilterLabels: Record<CustomerFilter, string> = {
  all: "Todos",
  active: "Clientes activos",
  prospects: "Prospectos",
  wholesale: "Mayoristas",
  wholesale_requests: "Solicitudes mayoristas",
  suspended: "Suspendidos",
};

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "Preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Pendiente",
  confirmed: "Confirmado",
  paid: "Pagado",
  preparing: "Preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

const emptyLead: CrmLeadInput = {
  business_name: "",
  contact_name: "",
  email: "",
  phone: "",
  tax_id: "",
  address: "",
  city: "",
  notes: "",
  lead_status: "prospecto",
  estimated_value: 0,
  monthly_amount: 0,
};

const emptyFollowup: CrmFollowupInput = {
  customer_id: "",
  title: "",
  interaction_type: "seguimiento",
  next_action: "",
  due_at: "",
  priority: "media",
  phone: "",
  notes: "",
  estimated_value: 0,
  monthly_amount: 0,
};

const emptyNote: CrmNoteInput = {
  customer_id: "",
  note: "",
};

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function customerDisplayName(customer: { business_name: string | null; contact_name: string }) {
  return customer.business_name || customer.contact_name;
}

function formatDateTime(value: string | null) {
  return value ? formatHnDateTime(value) : "Sin fecha";
}

function isOverdue(followup: CrmFollowupRow) {
  return followup.status === "pending" && followup.due_at ? new Date(followup.due_at) < new Date() : false;
}

function followupStatusLabel(followup: CrmFollowupRow) {
  if (isOverdue(followup)) {
    return "Atrasado";
  }
  if (followup.status === "completed") {
    return "Completado";
  }
  if (followup.status === "cancelled") {
    return "Archivado";
  }
  return "Pendiente";
}

export function CrmManager({ data, basePath = "/admin/crm", focus = "followups" }: CrmManagerProps) {
  const [query, setQuery] = useState("");
  const [lead, setLead] = useState<CrmLeadInput>(emptyLead);
  const [followup, setFollowup] = useState<CrmFollowupInput>(emptyFollowup);
  const [note, setNote] = useState<CrmNoteInput>(emptyNote);
  const [selectedCustomerId, setSelectedCustomerId] = useState(data.customers[0]?.id ?? "");
  const [selectedFollowupId, setSelectedFollowupId] = useState(data.followups[0]?.id ?? "");
  const [customerFilter, setCustomerFilter] = useState<CustomerFilter>("all");
  const [followupStatusFilter, setFollowupStatusFilter] = useState<"all" | "pending" | "completed" | "cancelled" | "overdue">("all");
  const [followupPriorityFilter, setFollowupPriorityFilter] = useState<"all" | CrmPriority>("all");
  const [followupTypeFilter, setFollowupTypeFilter] = useState<"all" | CrmInteractionType>("all");
  const [openLeadForm] = useState(false);
  const [openFollowupForm] = useState(false);
  const [openNoteForm] = useState(false);
  const [crmDrawer, setCrmDrawer] = useState<CrmDrawerMode>(null);
  const [mergeRequest, setMergeRequest] = useState<DuplicateMergeRequest | null>(null);
  const [profileCustomerId, setProfileCustomerId] = useState<string | null>(null);
  const [customerProfile, setCustomerProfile] = useState<CrmCustomerProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const debouncedQuery = useDebouncedValue(query, 400);

  const filteredFollowups = useMemo(() => {
    const normalized = debouncedQuery.trim().toLowerCase();
    return data.followups.filter((item) => {
      const matchesQuery =
        !normalized ||
        `${item.title} ${item.next_action ?? ""} ${item.notes ?? ""} ${item.customer_name ?? ""} ${item.business_name ?? ""}`
          .toLowerCase()
          .includes(normalized);
      const matchesStatus =
        followupStatusFilter === "all" ||
        (followupStatusFilter === "overdue" ? isOverdue(item) : item.status === followupStatusFilter);
      const matchesPriority = followupPriorityFilter === "all" || item.priority === followupPriorityFilter;
      const matchesType = followupTypeFilter === "all" || item.interaction_type === followupTypeFilter;

      return matchesQuery && matchesStatus && matchesPriority && matchesType;
    });
  }, [data.followups, debouncedQuery, followupPriorityFilter, followupStatusFilter, followupTypeFilter]);

  const searchedCustomers = useMemo(() => {
    const normalized = debouncedQuery.trim().toLowerCase();
    return data.customers.filter((customer) => {
      if (!normalized) {
        return true;
      }

      return `${customer.contact_name} ${customer.business_name ?? ""} ${customer.email ?? ""} ${customer.phone}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [data.customers, debouncedQuery]);

  const filteredCustomers = useMemo(
    () =>
      searchedCustomers.filter((customer) => {
        if (customerFilter === "active") {
          return customer.account_state === "Cliente activo" || (customer.active && customer.status === "active");
        }
        if (customerFilter === "prospects") {
          return customer.lead_status !== "cliente" && !customer.has_wholesale_request;
        }
        if (customerFilter === "wholesale") {
          return customer.is_wholesale;
        }
        if (customerFilter === "wholesale_requests") {
          return customer.has_wholesale_request && !customer.is_wholesale;
        }
        if (customerFilter === "suspended") {
          return customer.account_state === "Cuenta suspendida" || !customer.active || customer.status === "disabled";
        }

        return true;
      }),
    [customerFilter, searchedCustomers],
  );

  const pendingFollowups = data.followups.filter((item) => item.status === "pending");
  const overdueCount = data.followups.filter(isOverdue).length;
  const prospects = data.customers.filter((customer) => customer.lead_status !== "cliente");
  const wholesaleRequests = data.customers.filter((customer) => customer.notes?.includes("[SOLICITUD_MAYOREO]") && !customer.is_wholesale);
  const estimatedPipeline = prospects.reduce((sum, customer) => sum + customer.estimated_value, 0);
  const selectedCustomer = filteredCustomers.find((customer) => customer.id === selectedCustomerId) ?? filteredCustomers[0] ?? data.customers[0] ?? null;
  const selectedFollowup =
    data.followups.find((item) => item.id === selectedFollowupId) ?? filteredFollowups[0] ?? data.followups[0] ?? null;
  const selectedCustomerNotes = selectedCustomer ? data.notes.filter((item) => item.customer_id === selectedCustomer.id).slice(0, 5) : [];
  const selectedCustomerFollowups = selectedCustomer
    ? data.followups.filter((item) => item.customer_id === selectedCustomer.id).slice(0, 5)
    : [];

  function updateLead<K extends keyof CrmLeadInput>(field: K, value: CrmLeadInput[K]) {
    setLead((current) => ({ ...current, [field]: value }));
  }

  function updateFollowup<K extends keyof CrmFollowupInput>(field: K, value: CrmFollowupInput[K]) {
    setFollowup((current) => ({ ...current, [field]: value }));
  }

  function selectFollowupCustomer(customerId: string) {
    const customer = data.customers.find((item) => item.id === customerId);
    setFollowup((current) => ({
      ...current,
      customer_id: customerId,
      phone: customer?.phone ?? "",
    }));
  }

  function openLeadDrawer(customer?: CrmCustomerOption) {
    if (customer) {
      setLead({
        id: customer.id,
        business_name: customer.business_name ?? customer.company_name ?? "",
        contact_name: customer.contact_name,
        email: customer.email ?? customer.account_email ?? "",
        phone: customer.phone ?? customer.account_phone ?? "",
        tax_id: customer.tax_id ?? "",
        address: "",
        city: customer.city ?? "",
        notes: customer.notes ?? "",
        lead_status: customer.lead_status,
        estimated_value: customer.estimated_value,
        monthly_amount: customer.monthly_amount,
      });
    } else {
      setLead(emptyLead);
    }
    setCrmDrawer("lead");
  }

  function openFollowupDrawer(item?: CrmFollowupRow) {
    if (item) {
      setSelectedFollowupId(item.id);
      setFollowup({
        id: item.id,
        customer_id: item.customer_id,
        title: item.title,
        interaction_type: item.interaction_type,
        next_action: item.next_action ?? "",
        due_at: item.due_at ? item.due_at.slice(0, 16) : "",
        priority: item.priority,
        phone: item.phone ?? "",
        notes: item.notes ?? "",
        estimated_value: item.estimated_value,
        monthly_amount: item.monthly_amount,
        status: item.status,
      });
    } else {
      setFollowup(emptyFollowup);
    }
    setCrmDrawer("followup");
  }

  function openNoteDrawer(item?: CrmNoteRow) {
    if (item) {
      setNote({
        id: item.id,
        customer_id: item.customer_id,
        note_type: item.note_type ?? "nota",
        note: item.note,
      });
    } else {
      setNote(emptyNote);
    }
    setCrmDrawer("note");
  }

  function openFollowupDetail(item: CrmFollowupRow) {
    setSelectedFollowupId(item.id);
    setCrmDrawer("followup-detail");
  }

  async function closeCrmDrawer() {
    const hasLeadDraft = crmDrawer === "lead" && JSON.stringify(lead) !== JSON.stringify(emptyLead);
    const hasFollowupDraft = crmDrawer === "followup" && JSON.stringify(followup) !== JSON.stringify(emptyFollowup);
    const hasNoteDraft = crmDrawer === "note" && JSON.stringify(note) !== JSON.stringify(emptyNote);

    if (hasLeadDraft || hasFollowupDraft || hasNoteDraft) {
      const confirmed = await toast.confirm({
        title: "Cambios sin guardar",
        message: "Tienes cambios sin guardar. ¿Deseas salir?",
        confirmLabel: "Salir",
        cancelLabel: "Seguir editando",
        tone: "neutral",
      });
      if (!confirmed) {
        return;
      }
    }

    setCrmDrawer(null);
  }

  function submitLead() {
    startTransition(async () => {
      const result = await saveCrmLeadAction(lead);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cliente creado correctamente.");
        setLead(emptyLead);
        setCrmDrawer(null);
      } else {
        toast.error(result.message || "No se pudo guardar el cliente.");
      }
    });
  }

  function submitFollowup() {
    startTransition(async () => {
      const result = await saveCrmFollowupAction(followup);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Seguimiento creado correctamente.");
        setFollowup(emptyFollowup);
        setCrmDrawer(null);
      } else {
        toast.error(result.message || "No se pudo guardar el seguimiento.");
      }
    });
  }

  function submitNote() {
    startTransition(async () => {
      const result = await saveCrmNoteAction(note);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Nota agregada al cliente.");
        setNote(emptyNote);
        setCrmDrawer(null);
      } else {
        toast.error(result.message || "No se pudo guardar la nota.");
      }
    });
  }

  function setStatus(id: string, status: "completed" | "cancelled") {
    startTransition(async () => {
      const result = await setCrmFollowupStatusAction(id, status);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Seguimiento actualizado correctamente.");
      } else {
        toast.error(result.message || "No se pudo actualizar el seguimiento.");
      }
    });
  }

  async function archiveNote(item: CrmNoteRow) {
    const confirmed = await toast.confirm({
      title: "Archivar nota",
      message: "La nota quedará archivada y se conservará en el historial. ¿Deseas continuar?",
      confirmLabel: "Archivar",
      cancelLabel: "Cancelar",
      tone: "neutral",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await archiveCrmNoteAction(item.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Nota archivada correctamente.");
      } else {
        toast.error(result.message || "No se pudo archivar la nota.");
      }
    });
  }

  function approveWholesaleCustomer(customerId: string) {
    startTransition(async () => {
      const result = await approveWholesaleRequestAction(customerId);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Mayorista aprobado correctamente.");
      } else {
        toast.error(result.message || "No se pudo aprobar el mayorista.");
      }
    });
  }

  async function suspendCustomer(customer: CrmCustomerOption) {
    const confirmed = await toast.confirm({
      title: "Suspender cliente",
      message: `¿Suspender cuenta de ${customerDisplayName(customer)}? El cliente real no se elimina; solo queda inactivo.`,
      confirmLabel: "Suspender",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await suspendCustomerAccountAction(customer.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cuenta suspendida correctamente.");
      } else {
        toast.error(result.message || "No se pudo suspender la cuenta.");
      }
    });
  }

  async function reactivateCustomer(customer: CrmCustomerOption) {
    const confirmed = await toast.confirm({
      title: "Reactivar cliente",
      message: `¿Reactivar cuenta de ${customerDisplayName(customer)}? El cliente volverá a quedar activo para atención y operaciones.`,
      confirmLabel: "Reactivar",
      cancelLabel: "Cancelar",
      tone: "neutral",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await reactivateCustomerAccountAction(customer.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cuenta reactivada correctamente.");
      } else {
        toast.error(result.message || "No se pudo reactivar la cuenta.");
      }
    });
  }


  async function deleteTestCustomer(customer: CrmCustomerOption) {
    const email = customer.account_email ?? customer.email ?? "";
    if (!email) {
      toast.error("El cliente no tiene correo asociado.");
      return;
    }

    const confirmed = await toast.confirm({
      title: "Eliminar cuenta TEST",
      message:
        "Esta acción eliminará la cuenta TEST y sus datos relacionados. No usar con clientes reales. Confirmación requerida: ELIMINAR TEST.",
      confirmLabel: "ELIMINAR TEST",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await deleteTestAccountAction({ email, confirmation: "ELIMINAR TEST" });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cuenta TEST eliminada correctamente.");
      } else {
        toast.error(result.message || "No se pudo eliminar la cuenta TEST.");
      }
    });
  }

  function requestDuplicateMerge(source: CrmDuplicateCandidate, target: CrmDuplicateCandidate) {
    setMergeRequest({ source, target });
  }

  async function openCustomerProfile(customerId: string) {
    setSelectedCustomerId(customerId);
    setProfileCustomerId(customerId);
    setCustomerProfile(null);
    setProfileError(null);
    setProfileLoading(true);

    const result = await getCustomerProfileAction(customerId);
    if (result.ok && result.profile) {
      setCustomerProfile(result.profile);
    } else {
      setProfileError(result.message || "No se pudo cargar el perfil del cliente.");
      toast.error(result.message || "No se pudo cargar el perfil del cliente.");
    }

    setProfileLoading(false);
  }

  function closeCustomerProfile() {
    setProfileCustomerId(null);
    setProfileError(null);
  }

  function confirmDuplicateMerge() {
    if (!mergeRequest) {
      return;
    }

    const { source, target } = mergeRequest;
    startTransition(async () => {
      const result = await mergeDuplicateCustomerAction({ sourceCustomerId: source.id, targetCustomerId: target.id });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cliente duplicado unificado correctamente. El historial fue movido al perfil principal.");
        setMergeRequest(null);
      } else {
        toast.error(result.message || "No se pudo unificar el cliente duplicado.");
      }
    });
  }

  return (
    <div className="space-y-5">
      <PaginationControls
        basePath={basePath}
        page={focus === "customers" ? data.customerPage : data.followupPage}
        pageSize={data.pageSize}
        total={focus === "customers" ? data.customersTotal : data.followupsTotal}
        label={focus === "customers" ? "clientes" : "seguimientos"}
      />

      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="Prospectos" value={prospects.length.toLocaleString("es-HN")} />
        <Metric label="Pendientes" value={pendingFollowups.length.toLocaleString("es-HN")} />
        <Metric label="Atrasados" value={overdueCount.toLocaleString("es-HN")} />
        <Metric label="Solicitudes mayoreo" value={wholesaleRequests.length.toLocaleString("es-HN")} />
        <Metric label="Pipeline estimado" value={formatCurrency(estimatedPipeline)} />
      </div>

      {focus !== "customers" ? (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <HelpCard title="Prospecto" text="Persona o negocio interesado que aún no ha comprado." />
          <HelpCard title="Cliente" text="Persona o negocio con pedido, cuenta o relación comercial activa." />
          <HelpCard title="Seguimiento" text="Tarea pendiente para contactar al cliente o completar una acción." />
          <HelpCard title="Nota" text="Información importante: llamada, interés, duda o acuerdo." />
          <HelpCard title="Solicitud mayorista" text="Negocio que desea comprar con precios de mayoreo." />
        </section>
      ) : null}

      {focus !== "customers" ? (
      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Acciones CRM</h2>
            <p className="mt-1 text-sm text-black/55">
              Abre solo el formulario que vas a usar. El historial y las tareas quedan visibles abajo.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => openLeadDrawer()} variant="ghost">
              <UserPlus size={16} />
              Nuevo prospecto
            </Button>
            <Button onClick={() => openFollowupDrawer()} variant="ghost">
              <Clock size={16} />
              Nuevo seguimiento
            </Button>
            <Button onClick={() => openNoteDrawer()} variant="ghost">
              <MessageSquarePlus size={16} />
              Agregar nota
            </Button>
          </div>
        </div>
      </section>
      ) : null}

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={focus === "customers" ? "Buscar cliente, empresa, correo o teléfono" : "Buscar cliente, acción o nota"}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <Button
            onClick={() => {
              setQuery("");
              setCustomerFilter("all");
              setFollowupStatusFilter("all");
              setFollowupPriorityFilter("all");
              setFollowupTypeFilter("all");
            }}
            variant="ghost"
          >
            Limpiar filtros
          </Button>
        </div>
        {focus !== "customers" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <select
              value={followupTypeFilter}
              onChange={(event) => setFollowupTypeFilter(event.target.value as "all" | CrmInteractionType)}
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            >
              <option value="all">Todos los tipos</option>
              {Object.entries(interactionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={followupStatusFilter}
              onChange={(event) => setFollowupStatusFilter(event.target.value as "all" | "pending" | "completed" | "cancelled" | "overdue")}
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            >
              <option value="all">Todos los estados</option>
              <option value="pending">Pendiente</option>
              <option value="overdue">Atrasado</option>
              <option value="completed">Completado</option>
              <option value="cancelled">Archivado</option>
            </select>
            <select
              value={followupPriorityFilter}
              onChange={(event) => setFollowupPriorityFilter(event.target.value as "all" | CrmPriority)}
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            >
              <option value="all">Todas las prioridades</option>
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {message ? <p className="mt-3 text-sm text-black/60">{message}</p> : null}
      </section>

      {false ? (
      <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <div className={`rounded-lg border border-black/10 bg-white p-5 ${openLeadForm ? "" : "hidden"}`}>
          <div className="mb-4 flex items-center gap-2">
            <UserPlus size={19} />
            <div>
              <h2 className="font-semibold">Cliente potencial</h2>
              <p className="text-sm text-black/55">Registra una persona o empresa interesada antes de que haga una compra.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Empresa">
              <Input value={lead.business_name} onChange={(event) => updateLead("business_name", event.target.value)} />
            </Field>
            <Field label="Cliente">
              <Input value={lead.contact_name} onChange={(event) => updateLead("contact_name", event.target.value)} />
            </Field>
            <Field label="Teléfono">
              <Input value={lead.phone} onChange={(event) => updateLead("phone", event.target.value)} />
            </Field>
            <Field label="Correo">
              <Input type="email" value={lead.email} onChange={(event) => updateLead("email", event.target.value)} />
            </Field>
            <Field label="RTN">
              <Input value={lead.tax_id} onChange={(event) => updateLead("tax_id", event.target.value)} />
            </Field>
            <Field label="Ciudad">
              <Input value={lead.city} onChange={(event) => updateLead("city", event.target.value)} />
            </Field>
            <Field label="Valor estimado">
              <Input
                type="number"
                min={0}
                value={lead.estimated_value}
                onChange={(event) => updateLead("estimated_value", numberValue(event.target.value))}
              />
            </Field>
            <Field label="Mensualidad">
              <Input
                type="number"
                min={0}
                value={lead.monthly_amount}
                onChange={(event) => updateLead("monthly_amount", numberValue(event.target.value))}
              />
            </Field>
            <Field label="Estado">
              <select
                value={lead.lead_status}
                onChange={(event) => updateLead("lead_status", event.target.value as CrmLeadStatus)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                {Object.entries(leadStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dirección">
              <Input value={lead.address} onChange={(event) => updateLead("address", event.target.value)} />
            </Field>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
              <textarea
                value={lead.notes}
                onChange={(event) => updateLead("notes", event.target.value)}
                className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </label>
          </div>
          <Button onClick={submitLead} disabled={isPending} variant="dark" className="mt-4">
            <Save size={17} />
            Guardar cliente
          </Button>
        </div>

        <div className={`rounded-lg border border-black/10 bg-white p-5 ${openFollowupForm ? "" : "hidden"}`}>
          <div className="mb-4 flex items-center gap-2">
            <PhoneCall size={19} />
            <div>
              <h2 className="font-semibold">Seguimiento</h2>
              <p className="text-sm text-black/55">Agenda una llamada, visita o tarea para dar seguimiento a un cliente.</p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cliente">
              <CustomerSelect
                customers={data.customers}
                value={followup.customer_id}
                onChange={selectFollowupCustomer}
              />
            </Field>
            <Field label="Tipo">
              <select
                value={followup.interaction_type}
                onChange={(event) => updateFollowup("interaction_type", event.target.value as CrmInteractionType)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                {Object.entries(interactionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Titulo">
              <Input value={followup.title} onChange={(event) => updateFollowup("title", event.target.value)} />
            </Field>
            <Field label="Próxima acción">
              <Input value={followup.next_action} onChange={(event) => updateFollowup("next_action", event.target.value)} />
            </Field>
            <Field label="Teléfono / WhatsApp">
              <Input
                value={followup.phone}
                onChange={(event) => updateFollowup("phone", event.target.value)}
                placeholder="Ej. 31986284"
              />
            </Field>
            <Field label="Fecha">
              <Input type="datetime-local" value={followup.due_at} onChange={(event) => updateFollowup("due_at", event.target.value)} />
            </Field>
            <Field label="Prioridad">
              <select
                value={followup.priority}
                onChange={(event) => updateFollowup("priority", event.target.value as CrmPriority)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                {Object.entries(priorityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Valor estimado">
              <Input
                type="number"
                min={0}
                value={followup.estimated_value}
                onChange={(event) => updateFollowup("estimated_value", numberValue(event.target.value))}
              />
            </Field>
            <Field label="Mensualidad">
              <Input
                type="number"
                min={0}
                value={followup.monthly_amount}
                onChange={(event) => updateFollowup("monthly_amount", numberValue(event.target.value))}
              />
            </Field>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
              <textarea
                value={followup.notes}
                onChange={(event) => updateFollowup("notes", event.target.value)}
                className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
              />
            </label>
          </div>
          <Button onClick={submitFollowup} disabled={isPending} variant="dark" className="mt-4">
            <Clock size={17} />
            Guardar seguimiento
          </Button>
        </div>
      </section>
      ) : null}

      {focus === "customers" ? (
        <div className="space-y-5">
          <CustomerFilterTabs value={customerFilter} onChange={setCustomerFilter} />
          <CustomerAccountsTable
            customers={filteredCustomers}
            pending={isPending}
            onSelect={openCustomerProfile}
            onApproveWholesale={approveWholesaleCustomer}
            onSuspend={suspendCustomer}
            onReactivate={reactivateCustomer}
            onDeleteTest={deleteTestCustomer}
          />
          <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <DuplicateGroupsPanel
              groups={data.duplicateGroups}
              pending={isPending}
              onMerge={requestDuplicateMerge}
              onViewProfile={openCustomerProfile}
            />
            <RecentNotesCard notes={data.notes} />
          </section>
          <CustomerProfileDrawer
            open={Boolean(profileCustomerId)}
            profile={customerProfile}
            fallbackCustomer={data.customers.find((customer) => customer.id === profileCustomerId) ?? selectedCustomer}
            loading={profileLoading}
            error={profileError}
            pending={isPending}
            onClose={closeCustomerProfile}
            onApproveWholesale={approveWholesaleCustomer}
            onSuspend={suspendCustomer}
            onReactivate={reactivateCustomer}
            onDeleteTest={deleteTestCustomer}
          />
        </div>
      ) : null}

      {focus !== "customers" ? (
      <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <div className="overflow-hidden rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-5">
            <h2 className="font-semibold">Historial CRM</h2>
            <p className="mt-1 text-sm text-black/55">
              {filteredFollowups.length.toLocaleString("es-HN")} seguimientos en esta página.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                <tr>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">Actividad</th>
                  <th className="px-4 py-3">Próxima acción</th>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Prioridad</th>
                  <th className="px-4 py-3">Valor</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {filteredFollowups.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-black/55">
                      No se encontraron resultados con estos filtros.
                    </td>
                  </tr>
                ) : (
                filteredFollowups.map((item) => (
                  <tr key={item.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{item.business_name ?? item.customer_name ?? "Cliente"}</p>
                      <p className="text-xs text-black/45">{item.customer_name}</p>
                      <ContactActions
                        phone={item.phone}
                        customerName={item.business_name ?? item.customer_name}
                        className="mt-2"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{item.title}</p>
                      <p className="text-xs text-black/50">{interactionLabels[item.interaction_type]}</p>
                    </td>
                    <td className="px-4 py-3">{item.next_action ?? "-"}</td>
                    <td className={`px-4 py-3 ${isOverdue(item) ? "font-semibold text-[#9b341b]" : ""}`}>
                      {formatDateTime(item.due_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs">{priorityLabels[item.priority]}</span>
                    </td>
                    <td className="px-4 py-3">
                      <p>{formatCurrency(item.estimated_value)}</p>
                      <p className="text-xs text-black/45">Mensual {formatCurrency(item.monthly_amount)}</p>
                    </td>
                    <td className="px-4 py-3">{followupStatusLabel(item)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <IconButton label="Marcar completado" onClick={() => setStatus(item.id, "completed")}>
                          <CheckCircle2 size={16} />
                        </IconButton>
                        <IconButton label="Editar seguimiento" onClick={() => openFollowupDrawer(item)}>
                          <Save size={16} />
                        </IconButton>
                        <IconButton label="Archivar seguimiento" onClick={() => setStatus(item.id, "cancelled")}>
                          <X size={16} />
                        </IconButton>
                        <IconButton label="Ver detalle" onClick={() => openFollowupDetail(item)}>
                          <Search size={16} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="hidden">
          <CustomerDetailCard
            customer={selectedCustomer}
            pending={isPending}
            notes={selectedCustomerNotes}
            followups={selectedCustomerFollowups}
            onApproveWholesale={approveWholesaleCustomer}
            onSuspend={suspendCustomer}
            onReactivate={reactivateCustomer}
            onDeleteTest={deleteTestCustomer}
          />
          <FollowupDetailCard followup={selectedFollowup} />

          <div className="rounded-lg border border-black/10 bg-white p-5">
            <h2 className="font-semibold">Clientes CRM</h2>
            <p className="mt-1 text-sm text-black/55">{filteredCustomers.length.toLocaleString("es-HN")} clientes en esta página.</p>
            <div className="mt-4 space-y-3">
              {filteredCustomers.length === 0 ? (
                <p className="text-sm text-black/55">No hay clientes registrados.</p>
              ) : (
                filteredCustomers.map((customer) => (
                  <article
                    key={customer.id}
                    className={`rounded-md p-3 text-sm transition-colors ${
                      selectedCustomer?.id === customer.id ? "bg-[#fff1f2]" : "bg-[#f4f4f5]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">{customerDisplayName(customer)}</p>
                        <p className="mt-1 text-xs text-black/45">{customer.phone || "Sin teléfono"}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedCustomerId(customer.id)}
                        className="rounded-md border border-black/10 bg-white px-2 py-1 text-xs font-medium"
                      >
                        Detalle
                      </button>
                    </div>
                    <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} className="mt-2" />
                  </article>
                ))
              )}
            </div>
          </div>

          <div className={`rounded-lg border border-black/10 bg-white p-5 ${openNoteForm ? "" : "hidden"}`}>
            <div className="mb-4 flex items-center gap-2">
              <MessageSquarePlus size={19} />
              <div>
                <h2 className="font-semibold">Nueva nota</h2>
                <p className="text-sm text-black/55">Muestra actividades, pedidos, llamadas y notas relacionadas con clientes.</p>
              </div>
            </div>
            <div className="grid gap-3">
              <Field label="Cliente">
                <CustomerSelect
                  customers={data.customers}
                  value={note.customer_id}
                  onChange={(value) => setNote((current) => ({ ...current, customer_id: value }))}
                />
              </Field>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Nota</span>
                <textarea
                  value={note.note}
                  onChange={(event) => setNote((current) => ({ ...current, note: event.target.value }))}
                  className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                />
              </label>
              <Button onClick={submitNote} disabled={isPending} variant="dark">
                <Save size={17} />
                Guardar nota
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-black/10 bg-white p-5">
            <h2 className="font-semibold">Notas recientes</h2>
            <div className="mt-4 space-y-3">
              {data.notes.length === 0 ? (
                <p className="text-sm text-black/55">No hay notas registradas.</p>
              ) : (
                data.notes.slice(0, 8).map((item) => (
                  <article key={item.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                    <p className="font-semibold">{item.business_name ?? item.customer_name ?? "Cliente"}</p>
                    <p className="mt-1 text-black/60">{item.note}</p>
                    <p className="mt-2 text-xs text-black/45">{formatDateTime(item.created_at)}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
      ) : null}
      {focus !== "customers" ? (
        <RecentNotesCard notes={data.notes} onEdit={openNoteDrawer} onArchive={archiveNote} />
      ) : null}
      {focus !== "customers" ? (
        <CrmActionDrawer
          mode={crmDrawer}
          lead={lead}
          followup={followup}
          note={note}
          selectedFollowup={selectedFollowup}
          customers={data.customers}
          pending={isPending}
          onClose={closeCrmDrawer}
          onUpdateLead={updateLead}
          onUpdateFollowup={updateFollowup}
          onUpdateNote={(field, value) => setNote((current) => ({ ...current, [field]: value }))}
          onSelectFollowupCustomer={selectFollowupCustomer}
          onSubmitLead={submitLead}
          onSubmitFollowup={submitFollowup}
          onSubmitNote={submitNote}
          onEditFollowup={openFollowupDrawer}
          onCompleteFollowup={(id) => setStatus(id, "completed")}
          onArchiveFollowup={(id) => setStatus(id, "cancelled")}
          onViewCustomer={openCustomerProfile}
        />
      ) : null}
      {focus !== "customers" ? (
        <CustomerProfileDrawer
          open={Boolean(profileCustomerId)}
          profile={customerProfile}
          fallbackCustomer={data.customers.find((customer) => customer.id === profileCustomerId) ?? selectedCustomer}
          loading={profileLoading}
          error={profileError}
          pending={isPending}
          onClose={closeCustomerProfile}
          onApproveWholesale={approveWholesaleCustomer}
          onSuspend={suspendCustomer}
          onReactivate={reactivateCustomer}
          onDeleteTest={deleteTestCustomer}
        />
      ) : null}
      {mergeRequest ? (
        <DuplicateMergeConfirmModal
          request={mergeRequest}
          pending={isPending}
          onCancel={() => setMergeRequest(null)}
          onConfirm={confirmDuplicateMerge}
        />
      ) : null}
    </div>
  );
}

function CustomerFilterTabs({ value, onChange }: { value: CustomerFilter; onChange: (value: CustomerFilter) => void }) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {Object.entries(customerFilterLabels).map(([filter, label]) => {
          const active = value === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => onChange(filter as CustomerFilter)}
              className={`rounded-md border px-3 py-2 text-sm font-medium ${
                active ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white text-black/60"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CrmActionDrawer({
  mode,
  lead,
  followup,
  note,
  selectedFollowup,
  customers,
  pending,
  onClose,
  onUpdateLead,
  onUpdateFollowup,
  onUpdateNote,
  onSelectFollowupCustomer,
  onSubmitLead,
  onSubmitFollowup,
  onSubmitNote,
  onEditFollowup,
  onCompleteFollowup,
  onArchiveFollowup,
  onViewCustomer,
}: {
  mode: CrmDrawerMode;
  lead: CrmLeadInput;
  followup: CrmFollowupInput;
  note: CrmNoteInput;
  selectedFollowup: CrmFollowupRow | null;
  customers: AdminCrmData["customers"];
  pending: boolean;
  onClose: () => Promise<void>;
  onUpdateLead: <K extends keyof CrmLeadInput>(field: K, value: CrmLeadInput[K]) => void;
  onUpdateFollowup: <K extends keyof CrmFollowupInput>(field: K, value: CrmFollowupInput[K]) => void;
  onUpdateNote: <K extends keyof CrmNoteInput>(field: K, value: CrmNoteInput[K]) => void;
  onSelectFollowupCustomer: (customerId: string) => void;
  onSubmitLead: () => void;
  onSubmitFollowup: () => void;
  onSubmitNote: () => void;
  onEditFollowup: (followup: CrmFollowupRow) => void;
  onCompleteFollowup: (id: string) => void;
  onArchiveFollowup: (id: string) => void;
  onViewCustomer: (customerId: string) => void;
}) {
  useEffect(() => {
    if (!mode) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mode, onClose]);

  if (!mode) {
    return null;
  }

  const title =
    mode === "lead"
      ? lead.id
        ? "Editar prospecto"
        : "Nuevo prospecto"
      : mode === "followup"
        ? followup.id
          ? "Editar seguimiento"
          : "Nuevo seguimiento"
        : mode === "note"
          ? note.id
            ? "Editar nota"
            : "Agregar nota"
          : "Detalle de seguimiento";
  const help =
    mode === "lead"
      ? "Un prospecto es una persona o negocio interesado que aún no ha comprado."
      : mode === "followup"
        ? "Un seguimiento es una tarea pendiente para contactar al cliente o completar una acción."
        : mode === "note"
          ? "Una nota guarda información importante sobre el cliente, por ejemplo: llamada realizada, interés, duda o acuerdo."
          : "Revisa el detalle de la tarea antes de editarla, completarla o archivarla.";

  return (
    <div className="fixed inset-0 z-[85] bg-black/45 backdrop-blur-sm" onClick={() => void onClose()}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ml-auto flex h-full w-full flex-col bg-[#f4f4f5] text-[#080808] shadow-2xl md:max-w-[820px]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-black/10 bg-white px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase text-[#e4252c]">CRM</p>
              <h2 className="mt-1 text-xl font-semibold">{title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-black/60">{help}</p>
            </div>
            <button
              type="button"
              aria-label="Cerrar ventana CRM"
              onClick={() => void onClose()}
              className="grid size-10 shrink-0 place-items-center rounded-md border border-black/10 bg-white text-black/60 transition-colors hover:bg-[#f4f4f5] hover:text-[#080808]"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {mode === "lead" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Empresa">
                <Input value={lead.business_name} onChange={(event) => onUpdateLead("business_name", event.target.value)} />
              </Field>
              <Field label="Cliente">
                <Input value={lead.contact_name} onChange={(event) => onUpdateLead("contact_name", event.target.value)} />
              </Field>
              <Field label="Teléfono">
                <Input value={lead.phone} onChange={(event) => onUpdateLead("phone", event.target.value)} />
              </Field>
              <Field label="Correo electrónico">
                <Input type="email" value={lead.email} onChange={(event) => onUpdateLead("email", event.target.value)} />
              </Field>
              <Field label="RTN">
                <Input value={lead.tax_id} onChange={(event) => onUpdateLead("tax_id", event.target.value)} />
              </Field>
              <Field label="Ciudad">
                <Input value={lead.city} onChange={(event) => onUpdateLead("city", event.target.value)} />
              </Field>
              <Field label="Valor estimado">
                <Input type="number" min={0} value={lead.estimated_value} onChange={(event) => onUpdateLead("estimated_value", numberValue(event.target.value))} />
              </Field>
              <Field label="Mensualidad">
                <Input type="number" min={0} value={lead.monthly_amount} onChange={(event) => onUpdateLead("monthly_amount", numberValue(event.target.value))} />
              </Field>
              <Field label="Estado">
                <select
                  value={lead.lead_status}
                  onChange={(event) => onUpdateLead("lead_status", event.target.value as CrmLeadStatus)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                >
                  {Object.entries(leadStatusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Dirección">
                <Input value={lead.address} onChange={(event) => onUpdateLead("address", event.target.value)} />
              </Field>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
                <textarea
                  value={lead.notes}
                  onChange={(event) => onUpdateLead("notes", event.target.value)}
                  className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </label>
            </div>
          ) : null}

          {mode === "followup" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cliente">
                <CustomerSelect customers={customers} value={followup.customer_id} onChange={onSelectFollowupCustomer} />
              </Field>
              <Field label="Tipo">
                <select
                  value={followup.interaction_type}
                  onChange={(event) => onUpdateFollowup("interaction_type", event.target.value as CrmInteractionType)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                >
                  {Object.entries(interactionLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Acción">
                <Input value={followup.title} onChange={(event) => onUpdateFollowup("title", event.target.value)} />
              </Field>
              <Field label="Próxima acción">
                <Input value={followup.next_action} onChange={(event) => onUpdateFollowup("next_action", event.target.value)} />
              </Field>
              <Field label="Teléfono / WhatsApp">
                <Input value={followup.phone} onChange={(event) => onUpdateFollowup("phone", event.target.value)} placeholder="Ej. 31986284" />
              </Field>
              <Field label="Fecha próxima">
                <Input type="datetime-local" value={followup.due_at} onChange={(event) => onUpdateFollowup("due_at", event.target.value)} />
              </Field>
              <Field label="Prioridad">
                <select
                  value={followup.priority}
                  onChange={(event) => onUpdateFollowup("priority", event.target.value as CrmPriority)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                >
                  {Object.entries(priorityLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Estado">
                <select
                  value={followup.status ?? "pending"}
                  onChange={(event) => onUpdateFollowup("status", event.target.value as CrmFollowupRow["status"])}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                >
                  <option value="pending">Pendiente</option>
                  <option value="completed">Completado</option>
                  <option value="cancelled">Archivado</option>
                </select>
              </Field>
              <Field label="Valor estimado">
                <Input type="number" min={0} value={followup.estimated_value} onChange={(event) => onUpdateFollowup("estimated_value", numberValue(event.target.value))} />
              </Field>
              <Field label="Mensualidad">
                <Input type="number" min={0} value={followup.monthly_amount} onChange={(event) => onUpdateFollowup("monthly_amount", numberValue(event.target.value))} />
              </Field>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
                <textarea
                  value={followup.notes}
                  onChange={(event) => onUpdateFollowup("notes", event.target.value)}
                  className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </label>
            </div>
          ) : null}

          {mode === "note" ? (
            <div className="grid gap-3">
              <Field label="Cliente">
                <CustomerSelect customers={customers} value={note.customer_id} onChange={(value) => onUpdateNote("customer_id", value)} />
              </Field>
              <Field label="Tipo de nota">
                <select
                  value={note.note_type ?? "nota"}
                  onChange={(event) => onUpdateNote("note_type", event.target.value)}
                  className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                >
                  <option value="nota">Nota</option>
                  <option value="llamada">Llamada</option>
                  <option value="acuerdo">Acuerdo</option>
                  <option value="duda">Duda</option>
                  <option value="seguimiento">Seguimiento</option>
                </select>
              </Field>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Contenido</span>
                <textarea
                  value={note.note}
                  onChange={(event) => onUpdateNote("note", event.target.value)}
                  className="min-h-40 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                />
              </label>
            </div>
          ) : null}

          {mode === "followup-detail" && selectedFollowup ? (
            <div className="space-y-3 text-sm">
              <InfoLine label="Cliente" value={selectedFollowup.business_name ?? selectedFollowup.customer_name ?? "Cliente"} />
              <InfoLine label="Acción" value={selectedFollowup.title} />
              <InfoLine label="Tipo" value={interactionLabels[selectedFollowup.interaction_type]} />
              <InfoLine label="Próxima acción" value={selectedFollowup.next_action ?? "-"} />
              <InfoLine label="Fecha" value={formatDateTime(selectedFollowup.due_at)} />
              <InfoLine label="Prioridad" value={priorityLabels[selectedFollowup.priority]} />
              <InfoLine label="Estado" value={followupStatusLabel(selectedFollowup)} />
              <InfoLine label="Teléfono" value={selectedFollowup.phone ?? "Sin teléfono"} />
              {selectedFollowup.notes ? <p className="whitespace-pre-line rounded-md bg-white p-3">{selectedFollowup.notes}</p> : null}
              <ContactActions phone={selectedFollowup.phone} customerName={selectedFollowup.business_name ?? selectedFollowup.customer_name} />
            </div>
          ) : null}
        </div>

        <footer className="shrink-0 border-t border-black/10 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => void onClose()}>
              Cancelar
            </Button>
            {mode === "lead" ? (
              <Button type="button" variant="dark" disabled={pending} onClick={onSubmitLead}>
                <Save size={17} />
                {lead.id ? "Guardar cambios" : "Crear prospecto"}
              </Button>
            ) : null}
            {mode === "followup" ? (
              <Button type="button" variant="dark" disabled={pending} onClick={onSubmitFollowup}>
                <Save size={17} />
                {followup.id ? "Guardar cambios" : "Crear seguimiento"}
              </Button>
            ) : null}
            {mode === "note" ? (
              <Button type="button" variant="dark" disabled={pending} onClick={onSubmitNote}>
                <Save size={17} />
                {note.id ? "Guardar cambios" : "Agregar nota"}
              </Button>
            ) : null}
            {mode === "followup-detail" && selectedFollowup ? (
              <>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => onViewCustomer(selectedFollowup.customer_id)}>
                  Ver cliente
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => onEditFollowup(selectedFollowup)}>
                  Editar
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => onArchiveFollowup(selectedFollowup.id)}>
                  Archivar
                </Button>
                <Button type="button" variant="dark" disabled={pending} onClick={() => onCompleteFollowup(selectedFollowup.id)}>
                  Marcar completado
                </Button>
              </>
            ) : null}
          </div>
        </footer>
      </aside>
    </div>
  );
}

function DuplicateGroupsPanel({
  groups,
  pending,
  onMerge,
  onViewProfile,
}: {
  groups: CrmDuplicateGroup[];
  pending: boolean;
  onMerge: (source: CrmDuplicateCandidate, target: CrmDuplicateCandidate) => void;
  onViewProfile: (customerId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleGroups = showAll ? groups : groups.slice(0, 5);

  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Posibles clientes duplicados</h2>
          <p className="mt-1 text-sm text-black/55">
            El sistema encontró clientes que podrían ser la misma persona por correo o teléfono.
          </p>
        </div>
        {groups.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className="rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5]"
          >
            {showAll ? "Ver menos" : "Ver todos los duplicados"}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-black/55">
        Detectamos posibles registros duplicados del mismo cliente. Puedes unirlos para mantener un solo historial de pedidos, notas y seguimientos.
      </p>
      <details className="mt-3 rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm text-black/65">
        <summary className="cursor-pointer font-semibold text-[#080808]">¿Qué significa unificar?</summary>
        <p className="mt-2">
          Unificar mueve el historial de un registro duplicado hacia el cliente principal para que el equipo vea toda la información en un solo perfil.
        </p>
      </details>
      <div className="mt-4 space-y-3">
        {groups.length === 0 ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">No se encontraron posibles duplicados.</p>
        ) : (
          visibleGroups.map((group) => {
            const target = group.customers[0];
            const duplicates = group.customers.slice(1);

            return (
              <article key={group.key} className="rounded-lg border border-black/10 bg-[#f4f4f5] p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">
                      Coincidencia por {group.match_type === "email" ? "correo" : "teléfono"}: {group.label}
                    </p>
                    <p className="mt-1 text-xs text-black/50">Revisa cuál registro debe quedar como principal antes de unificar.</p>
                  </div>
                  <span className="rounded-md bg-white px-2 py-1 text-xs">{group.customers.length} registros</span>
                </div>

                <div className="mt-3 rounded-md bg-white p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase text-black/50">Cliente principal</p>
                      <DuplicateCustomerSummary customer={target} />
                    </div>
                    <Button type="button" variant="ghost" onClick={() => onViewProfile(target.id)}>
                      Ver perfil
                    </Button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  <p className="text-xs font-semibold uppercase text-black/50">Duplicados sugeridos</p>
                  {duplicates.map((customer) => (
                    <div key={customer.id} className="rounded-md bg-white p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <DuplicateCustomerSummary customer={customer} />
                        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                          <Button type="button" variant="ghost" onClick={() => onViewProfile(customer.id)}>
                            Ver perfil
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={pending || !customer.can_merge}
                            onClick={() => onMerge(customer, target)}
                          >
                            Unir con principal
                          </Button>
                          {!customer.can_merge ? (
                            <p className="max-w-48 text-xs text-[#7c2d12]">Tiene historial fiscal; requiere revisión manual.</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                  {duplicates.length === 0 ? <p className="text-xs text-black/50">No hay registros sugeridos para unir.</p> : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function DuplicateCustomerSummary({ customer }: { customer: CrmDuplicateCandidate }) {
  return (
    <div>
      <p className="font-semibold">{customer.display_name}</p>
      <p className="mt-1 text-xs text-black/45">{customer.email ?? "Sin correo"}</p>
      <p className="text-xs text-black/45">{customer.phone ?? "Sin teléfono"}</p>
      <p className="mt-2 text-xs text-black/50">
        Pedidos: {customer.order_count.toLocaleString("es-HN")} · Facturas: {customer.invoice_count.toLocaleString("es-HN")}
      </p>
    </div>
  );
}

function DuplicateMergeConfirmModal({
  request,
  pending,
  onCancel,
  onConfirm,
}: {
  request: DuplicateMergeRequest;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/45 px-4 py-6">
      <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 text-[#080808] shadow-xl">
        <h2 className="text-xl font-semibold">Unificar cliente duplicado</h2>
        <p className="mt-2 text-sm leading-6 text-black/65">
          Este registro se unirá al cliente principal. Sus pedidos, notas, seguimientos y códigos mayoristas se moverán al perfil principal.
          No se eliminarán facturas ni historial fiscal.
        </p>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-[#e4252c]/25 bg-[#fff1f2] p-4">
            <p className="text-xs font-semibold uppercase text-[#b91c25]">Cliente principal</p>
            <DuplicateCustomerSummary customer={request.target} />
            <p className="mt-3 text-xs text-black/55">Este será el perfil que conservará el historial unificado.</p>
          </div>
          <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-xs font-semibold uppercase text-black/50">Registro duplicado</p>
            <DuplicateCustomerSummary customer={request.source} />
            <p className="mt-3 text-xs text-black/55">Este registro quedará inactivo después de mover su historial.</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-[#f59e0b]/30 bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          Si el registro duplicado tiene facturas, el backend bloquea la unificación automática para proteger el historial fiscal.
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" variant="dark" disabled={pending} onClick={onConfirm}>
            {pending ? "Unificando..." : "Unificar cliente"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function RecentNotesCard({
  notes,
  onEdit,
  onArchive,
}: {
  notes: CrmNoteRow[];
  onEdit?: (note: CrmNoteRow) => void;
  onArchive?: (note: CrmNoteRow) => void;
}) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <h2 className="font-semibold">Notas recientes</h2>
      <p className="mt-1 text-sm text-black/55">Vista compacta. El detalle del cliente muestra su historial relacionado.</p>
      <div className="mt-4 space-y-3">
        {notes.length === 0 ? (
          <p className="text-sm text-black/55">No hay notas registradas.</p>
        ) : (
          notes.slice(0, 5).map((item) => (
            <article key={item.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{item.business_name ?? item.customer_name ?? "Cliente"}</p>
                  <p className="mt-1 text-xs text-black/45">
                    {item.note_type ?? "nota"} {item.user_id ? `- Usuario ${item.user_id.slice(0, 8)}` : ""}
                  </p>
                </div>
                {item.archived_at ? <InfoPill>Archivado</InfoPill> : null}
              </div>
              <p className="mt-1 line-clamp-2 text-black/60">{item.note}</p>
              <p className="mt-2 text-xs text-black/45">{formatDateTime(item.created_at)}</p>
              {onEdit || onArchive ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {onEdit ? (
                    <Button type="button" variant="ghost" onClick={() => onEdit(item)}>
                      Editar
                    </Button>
                  ) : null}
                  {onArchive && !item.archived_at ? (
                    <Button type="button" variant="ghost" onClick={() => onArchive(item)}>
                      Archivar
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

type CustomerProfileTab = "resumen" | "pedidos" | "facturas" | "crm" | "mayorista" | "acciones";

const customerProfileTabs: Array<{ id: CustomerProfileTab; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "pedidos", label: "Pedidos" },
  { id: "facturas", label: "Facturas" },
  { id: "crm", label: "CRM" },
  { id: "mayorista", label: "Mayorista" },
  { id: "acciones", label: "Acciones" },
];

function CustomerProfileDrawer({
  open,
  profile,
  fallbackCustomer,
  loading,
  error,
  pending,
  onClose,
  onApproveWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
}: {
  open: boolean;
  profile: CrmCustomerProfile | null;
  fallbackCustomer: CrmCustomerOption | null;
  loading: boolean;
  error: string | null;
  pending: boolean;
  onClose: () => void;
  onApproveWholesale: (customerId: string) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
}) {
  const [activeTab, setActiveTab] = useState<CustomerProfileTab>("resumen");
  const customer = profile?.customer ?? fallbackCustomer;
  const isWholesaleRequest = Boolean(customer?.notes?.includes("[SOLICITUD_MAYOREO]") || customer?.has_wholesale_request);
  const isSuspended = customer?.account_state === "Cuenta suspendida" || customer?.status === "disabled" || customer?.active === false;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-sm" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Perfil completo del cliente"
        className="ml-auto flex h-full w-full flex-col bg-[#f4f4f5] text-[#080808] shadow-2xl md:max-w-[860px] lg:max-w-[900px]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-black/10 bg-white px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-[#e4252c]">Perfil completo</p>
              <h2 className="mt-1 truncate text-xl font-semibold">{customer ? customerDisplayName(customer) : "Cargando cliente"}</h2>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {customer ? (
                  <>
                    <span className="rounded-md bg-[#fff1f2] px-2 py-1 font-semibold text-[#b91c25]">
                      {customer.customer_type === "Retail" ? "Cliente al detalle" : "Mayorista"}
                    </span>
                    <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-black/60">{customer.account_state}</span>
                    {isWholesaleRequest && !customer.is_wholesale ? (
                      <span className="rounded-md bg-[#fff7ed] px-2 py-1 text-[#7c2d12]">Solicitud mayorista</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              aria-label="Cerrar perfil del cliente"
              onClick={onClose}
              className="grid size-10 shrink-0 place-items-center rounded-md border border-black/10 bg-white text-black/60 transition-colors hover:bg-[#f4f4f5] hover:text-[#080808]"
            >
              <X size={18} />
            </button>
          </div>
          <nav className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {customerProfileTabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 rounded-md border px-3 py-2 text-sm font-semibold transition-all ${
                    active ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white text-black/60 hover:bg-[#f4f4f5]"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {loading ? (
            <div className="space-y-3">
              <div className="h-24 animate-pulse rounded-lg bg-white" />
              <div className="h-44 animate-pulse rounded-lg bg-white" />
              <div className="h-32 animate-pulse rounded-lg bg-white" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-[#e4252c]/25 bg-white p-5 text-sm text-[#b91c25]">{error}</div>
          ) : customer && profile ? (
            <>
              {activeTab === "resumen" ? <CustomerProfileSummary profile={profile} /> : null}
              {activeTab === "pedidos" ? <CustomerProfileOrders orders={profile.orders} /> : null}
              {activeTab === "facturas" ? <CustomerProfileInvoices invoices={profile.invoices} /> : null}
              {activeTab === "crm" ? <CustomerProfileCrm notes={profile.notes} followups={profile.followups} /> : null}
              {activeTab === "mayorista" ? <CustomerProfileWholesale profile={profile} /> : null}
              {activeTab === "acciones" ? (
                <CustomerProfileActions
                  customer={customer}
                  pending={pending}
                  isWholesaleRequest={isWholesaleRequest}
                  isSuspended={isSuspended}
                  onApproveWholesale={onApproveWholesale}
                  onSuspend={onSuspend}
                  onReactivate={onReactivate}
                  onDeleteTest={onDeleteTest}
                />
              ) : null}
            </>
          ) : (
            <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/55">
              Selecciona un cliente para cargar su perfil completo.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function CustomerProfileSummary({ profile }: { profile: CrmCustomerProfile }) {
  const { customer } = profile;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <Metric label="Total comprado" value={formatCurrency(customer.total_spent)} />
        <Metric label="Pedidos" value={customer.order_count.toLocaleString("es-HN")} />
        <Metric label="Facturas" value={customer.invoice_count.toLocaleString("es-HN")} />
      </section>
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h3 className="font-semibold">Datos generales</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <InfoLine label="Nombre" value={customerDisplayName(customer)} />
          <InfoLine label="Correo" value={customer.account_email ?? customer.email ?? "Sin correo"} />
          <InfoLine label="Teléfono" value={customer.account_phone ?? customer.phone ?? "Sin teléfono"} />
          <InfoLine label="Ciudad" value={customer.city ?? "Sin ciudad"} />
          <InfoLine label="RTN" value={customer.tax_id ?? "Sin RTN"} />
          <InfoLine label="Estado de cuenta" value={customer.account_state} />
          <InfoLine label="Tipo de cliente" value={customer.customer_type === "Retail" ? "Cliente al detalle" : "Mayorista"} />
          <InfoLine label="Mayorista" value={customer.is_wholesale ? "Sí" : customer.has_wholesale_request ? "Solicitud pendiente" : "No"} />
          <InfoLine label="Correo confirmado" value={customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"} />
          <InfoLine label="Última actividad" value={formatDateTime(customer.last_activity_at)} />
        </div>
      </section>
    </div>
  );
}

function CustomerProfileOrders({ orders }: { orders: CrmCustomerProfile["orders"] }) {
  return (
    <ProfileTableCard title="Pedidos del cliente" empty="Este cliente no tiene pedidos registrados.">
      {orders.map((order) => (
        <ProfileRow key={order.id}>
          <div>
            <p className="font-semibold">{order.order_number}</p>
            <p className="text-xs text-black/45">{formatDateTime(order.created_at)}</p>
          </div>
          <InfoPill>{orderStatusLabels[order.status] ?? order.status}</InfoPill>
          <p className="text-sm">{paymentMethodLabels[order.payment_method] ?? order.payment_method}</p>
          <p className="text-sm font-semibold">{formatCurrency(order.total)}</p>
          <Link href="/admin/pedidos" className="text-sm font-semibold text-[#e4252c] hover:text-[#b91c25]">
            Ver pedido
          </Link>
        </ProfileRow>
      ))}
      {orders.length === 0 ? null : <p className="mt-3 text-xs text-black/45">Se muestran los últimos {orders.length} pedidos relacionados.</p>}
    </ProfileTableCard>
  );
}

function CustomerProfileInvoices({ invoices }: { invoices: CrmCustomerProfile["invoices"] }) {
  return (
    <ProfileTableCard title="Facturas emitidas" empty="Este cliente no tiene facturas emitidas.">
      {invoices.map((invoice) => (
        <ProfileRow key={invoice.id}>
          <div>
            <p className="font-semibold">{invoice.invoice_number}</p>
            <p className="text-xs text-black/45">{formatDateTime(invoice.issued_at ?? invoice.created_at)}</p>
          </div>
          <InfoPill>{invoice.status}</InfoPill>
          <p className="text-sm">{invoice.order_number ?? "Sin pedido"}</p>
          <p className="text-sm font-semibold">{formatCurrency(invoice.total)}</p>
          <Link href="/admin/facturas" className="text-sm font-semibold text-[#e4252c] hover:text-[#b91c25]">
            Ver factura
          </Link>
        </ProfileRow>
      ))}
    </ProfileTableCard>
  );
}

function CustomerProfileCrm({ notes, followups }: { notes: CrmNoteRow[]; followups: CrmFollowupRow[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h3 className="font-semibold">Seguimientos</h3>
        <div className="mt-4 space-y-3">
          {followups.length === 0 ? (
            <p className="text-sm text-black/55">Sin seguimientos registrados.</p>
          ) : (
            followups.map((followup) => (
              <article key={followup.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{followup.title}</p>
                    <p className="text-xs text-black/50">{interactionLabels[followup.interaction_type]} - {formatDateTime(followup.due_at)}</p>
                  </div>
                  <InfoPill>{priorityLabels[followup.priority]}</InfoPill>
                </div>
                {followup.next_action ? <p className="mt-2 text-black/65">Próxima acción: {followup.next_action}</p> : null}
              </article>
            ))
          )}
        </div>
      </section>
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h3 className="font-semibold">Notas</h3>
        <div className="mt-4 space-y-3">
          {notes.length === 0 ? (
            <p className="text-sm text-black/55">Sin notas registradas.</p>
          ) : (
            notes.map((note) => (
              <article key={note.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                <p className="whitespace-pre-line text-black/70">{note.note}</p>
                <p className="mt-2 text-xs text-black/45">{formatDateTime(note.created_at)}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function CustomerProfileWholesale({ profile }: { profile: CrmCustomerProfile }) {
  const { customer, wholesaleCodes } = profile;

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Información mayorista</h3>
          <p className="mt-1 text-sm text-black/55">
            {customer.is_wholesale ? "Cliente con acceso mayorista." : customer.has_wholesale_request ? "Solicitud mayorista pendiente." : "Cliente sin acceso mayorista."}
          </p>
        </div>
        <InfoPill>{customer.status}</InfoPill>
      </div>
      <div className="mt-4 space-y-3">
        {wholesaleCodes.length === 0 ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">No hay códigos mayoristas vinculados.</p>
        ) : (
          wholesaleCodes.map((code) => (
            <article key={code.id} className="rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{code.label}</p>
                  <p className="text-xs text-black/50">{code.code}</p>
                </div>
                <InfoPill>{code.active ? "Activo" : "Inactivo"}</InfoPill>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <InfoLine label="Mínimo" value={formatCurrency(code.minimum_order)} />
                <InfoLine label="Usos" value={`${code.used_count}${code.max_uses ? ` / ${code.max_uses}` : ""}`} />
                <InfoLine label="Vence" value={formatDateTime(code.expires_at)} />
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function CustomerProfileActions({
  customer,
  pending,
  isWholesaleRequest,
  isSuspended,
  onApproveWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
}: {
  customer: CrmCustomerOption;
  pending: boolean;
  isWholesaleRequest: boolean;
  isSuspended: boolean;
  onApproveWholesale: (customerId: string) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
}) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="font-semibold">Acciones del cliente</h3>
      <p className="mt-1 text-sm text-black/55">Acciones rápidas y cambios sensibles con confirmación.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} />
        <Link href="/admin/pedidos" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver pedidos
        </Link>
        <Link href="/admin/facturas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver facturas
        </Link>
        <Link href="/admin/codigos-mayoristas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver códigos mayoristas
        </Link>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-black/10 pt-4">
        {isWholesaleRequest && !customer.is_wholesale ? (
          <Button onClick={() => onApproveWholesale(customer.id)} disabled={pending} variant="dark">
            Aprobar como mayorista
          </Button>
        ) : null}
        {isSuspended ? (
          <Button onClick={() => onReactivate(customer)} disabled={pending} variant="dark">
            <CheckCircle2 size={16} />
            Reactivar cuenta
          </Button>
        ) : (
          <Button onClick={() => onSuspend(customer)} disabled={pending} variant="ghost">
            <Ban size={16} />
            Suspender cuenta
          </Button>
        )}
        {customer.is_test_account ? (
          <Button onClick={() => onDeleteTest(customer)} disabled={pending} variant="secondary">
            <Trash2 size={16} />
            Eliminar cuenta TEST
          </Button>
        ) : (
          <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-xs text-black/55">
            Eliminación directa bloqueada para clientes reales.
          </p>
        )}
      </div>
      <div className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
        Para unificar duplicados, usa el panel de posibles duplicados y revisa primero el perfil principal y el registro sugerido.
      </div>
    </section>
  );
}

function ProfileTableCard({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasRows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-4 space-y-2">
        {hasRows ? children : <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">{empty}</p>}
      </div>
    </section>
  );
}

function ProfileRow({ children }: { children: React.ReactNode }) {
  return (
    <article className="grid gap-3 rounded-md border border-black/10 bg-[#f4f4f5] p-3 sm:grid-cols-[1.3fr_auto_1fr_auto_auto] sm:items-center">
      {children}
    </article>
  );
}

function InfoPill({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex w-fit rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold text-[#b91c25]">{children}</span>;
}

function CustomerDetailCard({
  customer,
  pending,
  notes,
  followups,
  onApproveWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
}: {
  customer: CrmCustomerOption | null;
  pending: boolean;
  notes: CrmNoteRow[];
  followups: CrmFollowupRow[];
  onApproveWholesale: (customerId: string) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
}) {
  const isWholesaleRequest = Boolean(customer?.notes?.includes("[SOLICITUD_MAYOREO]"));
  const isSuspended = customer?.account_state === "Cuenta suspendida" || customer?.status === "disabled" || customer?.active === false;

  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <div>
        <p className="text-xs font-semibold uppercase text-[#e4252c]">Detalle completo</p>
        <h2 className="mt-1 font-semibold">Perfil completo del cliente</h2>
      </div>
      {customer ? (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="font-semibold">{customerDisplayName(customer)}</p>
            <p className="text-xs text-black/45">{customer.email ?? "Sin correo registrado"}</p>
          </div>
          <InfoLine label="Teléfono" value={customer.phone || "Sin teléfono"} />
          <InfoLine label="Tipo de cliente" value={customer.customer_type === "Retail" ? "Cliente al detalle" : "Mayorista"} />
          <InfoLine label="Estado CRM" value={leadStatusLabels[customer.lead_status]} />
          <InfoLine label="Estado de cuenta" value={customer.account_state} />
          <InfoLine label="Correo confirmado" value={customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"} />
          <InfoLine label="Pedidos" value={customer.order_count.toLocaleString("es-HN")} />
          <InfoLine label="Facturas" value={customer.invoice_count.toLocaleString("es-HN")} />
          <InfoLine label="Códigos mayoristas" value={customer.wholesale_code_count.toLocaleString("es-HN")} />
          <InfoLine label="Total comprado" value={formatCurrency(customer.total_spent)} />
          <InfoLine label="Registro" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
          <InfoLine label="Última actividad" value={formatDateTime(customer.last_activity_at)} />
          <InfoLine label="Mayorista" value={customer.is_wholesale ? `Sí, estado ${customer.status}` : isWholesaleRequest ? "Solicitud pendiente" : "No"} />
          <InfoLine label="Ciudad" value={customer.city ?? "Sin ciudad"} />
          <InfoLine label="RTN" value={customer.tax_id ?? "Sin RTN"} />
          <InfoLine label="Valor estimado" value={formatCurrency(customer.estimated_value)} />
          <InfoLine label="Mensualidad" value={formatCurrency(customer.monthly_amount)} />
          <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Link href="/admin/pedidos" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver pedidos
            </Link>
            <Link href="/admin/facturas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver facturas
            </Link>
            <Link href="/admin/codigos-mayoristas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver códigos
            </Link>
          </div>
          <div className="rounded-md bg-[#f4f4f5] p-3">
            <p className="text-xs font-medium uppercase text-black/50">Seguimientos recientes</p>
            <div className="mt-2 space-y-2">
              {followups.length === 0 ? (
                <p className="text-xs text-black/50">Sin seguimientos recientes.</p>
              ) : (
                followups.map((item) => (
                  <div key={item.id} className="rounded-md bg-white p-2">
                    <p className="font-medium">{item.title}</p>
                    <p className="text-xs text-black/50">{interactionLabels[item.interaction_type]} - {formatDateTime(item.due_at)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="rounded-md bg-[#f4f4f5] p-3">
            <p className="text-xs font-medium uppercase text-black/50">Notas del cliente</p>
            <div className="mt-2 space-y-2">
              {notes.length === 0 ? (
                <p className="text-xs text-black/50">Sin notas recientes.</p>
              ) : (
                notes.map((item) => (
                  <div key={item.id} className="rounded-md bg-white p-2">
                    <p className="line-clamp-2 text-black/70">{item.note}</p>
                    <p className="mt-1 text-xs text-black/45">{formatDateTime(item.created_at)}</p>
                  </div>
                ))
              )}
            </div>
          </div>
          {isWholesaleRequest && !customer.is_wholesale ? (
            <div className="rounded-md border border-[#e4252c]/25 bg-[#fff7ed] p-3">
              <p className="font-medium text-[#7c2d12]">Solicitud de cuenta mayorista pendiente</p>
              <p className="mt-1 text-xs text-[#7c2d12]/80">
                Aprobar no activa precios por sí solo: también debe existir una cuenta vinculada y un código único.
              </p>
              <Button onClick={() => onApproveWholesale(customer.id)} disabled={pending} variant="dark" className="mt-3">
                Aprobar como mayorista
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {isSuspended ? (
              <Button onClick={() => onReactivate(customer)} disabled={pending} variant="dark">
                <CheckCircle2 size={16} />
                Reactivar cuenta
              </Button>
            ) : (
              <Button onClick={() => onSuspend(customer)} disabled={pending} variant="ghost">
                <Ban size={16} />
                Suspender cuenta
              </Button>
            )}
            {customer.is_test_account ? (
              <Button onClick={() => onDeleteTest(customer)} disabled={pending} variant="secondary">
                <Trash2 size={16} />
                Eliminar cuenta TEST
              </Button>
            ) : (
              <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-xs text-black/55">
                Eliminación directa bloqueada para clientes reales.
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-black/55">No hay cliente seleccionado.</p>
      )}
    </div>
  );
}

function CustomerAccountsTable({
  customers,
  pending,
  onSelect,
  onApproveWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
}: {
  customers: CrmCustomerOption[];
  pending: boolean;
  onSelect: (customerId: string) => void;
  onApproveWholesale: (customerId: string) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="border-b border-black/10 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Cuentas de clientes</h2>
            <p className="mt-1 text-sm text-black/55">
              Clientes registrados, confirmación de correo, actividad y acciones seguras.
            </p>
          </div>
          <div className="flex max-w-xl gap-2 rounded-md border border-[#e4252c]/25 bg-[#fff7ed] p-3 text-xs text-[#7c2d12]">
            <ShieldAlert size={18} className="shrink-0" />
            <p>Esta acción eliminará la cuenta TEST y sus datos relacionados. No usar con clientes reales.</p>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Correo</th>
              <th className="px-4 py-3">Teléfono</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Estado de cuenta</th>
              <th className="px-4 py-3">Correo confirmado</th>
              <th className="px-4 py-3">Pedidos</th>
              <th className="px-4 py-3">Última actividad</th>
              <th className="px-4 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {customers.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-sm text-black/55" colSpan={9}>
                  No hay clientes para mostrar.
                </td>
              </tr>
            ) : (
              customers.map((customer) => {
                const email = customer.account_email ?? customer.email ?? "";
                const isWholesaleRequest = customer.has_wholesale_request && !customer.is_wholesale;

                return (
                  <tr key={customer.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{customerDisplayName(customer)}</p>
                      <p className="text-xs text-black/45">Registro: {formatDateTime(customer.account_created_at ?? customer.created_at)}</p>
                    </td>
                    <td className="px-4 py-3">{email || "Sin correo"}</td>
                    <td className="px-4 py-3">{customer.account_phone ?? customer.phone ?? "Sin teléfono"}</td>
                    <td className="px-4 py-3">{customer.customer_type}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-medium">{customer.account_state}</span>
                    </td>
                    <td className="px-4 py-3">{customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"}</td>
                    <td className="px-4 py-3">{customer.order_count.toLocaleString("es-HN")}</td>
                    <td className="px-4 py-3">{formatDateTime(customer.last_activity_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => onSelect(customer.id)}
                          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5]"
                        >
                          <Search size={15} />
                          Detalle completo
                        </button>
                        <LinkIconButton label="Ver pedidos" href="/admin/pedidos">
                          <PackageSearch size={16} />
                        </LinkIconButton>
                        <LinkIconButton label="Ver CRM" href="/admin/crm">
                          <ExternalLink size={16} />
                        </LinkIconButton>
                        {isWholesaleRequest ? (
                          <IconButton label="Aprobar mayorista" onClick={() => onApproveWholesale(customer.id)}>
                            <CheckCircle2 size={16} />
                          </IconButton>
                        ) : null}
                        {customer.account_state === "Cuenta suspendida" || customer.status === "disabled" || customer.active === false ? (
                          <IconButton label="Reactivar cuenta" onClick={() => onReactivate(customer)}>
                            <CheckCircle2 size={16} />
                          </IconButton>
                        ) : (
                          <IconButton label="Suspender cuenta" onClick={() => onSuspend(customer)}>
                            <Ban size={16} />
                          </IconButton>
                        )}
                        {customer.is_test_account ? (
                          <IconButton label="Eliminar cuenta TEST" onClick={() => onDeleteTest(customer)}>
                            <Trash2 size={16} />
                          </IconButton>
                        ) : null}
                      </div>
                      {pending ? <p className="mt-2 text-right text-xs text-black/45">Procesando...</p> : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FollowupDetailCard({ followup }: { followup: CrmFollowupRow | null }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <h2 className="font-semibold">Detalle de seguimiento comercial</h2>
      {followup ? (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="font-semibold">{followup.title}</p>
            <p className="text-xs text-black/45">{followup.business_name ?? followup.customer_name ?? "Cliente"}</p>
          </div>
          <InfoLine label="Tipo" value={interactionLabels[followup.interaction_type]} />
          <InfoLine label="Próxima acción" value={followup.next_action ?? "-"} />
          <InfoLine label="Fecha" value={formatDateTime(followup.due_at)} />
          <InfoLine label="Prioridad" value={priorityLabels[followup.priority]} />
          <InfoLine label="Teléfono" value={followup.phone ?? "Sin teléfono"} />
          {followup.notes ? <p className="whitespace-pre-line rounded-md bg-[#f4f4f5] p-3">{followup.notes}</p> : null}
          <ContactActions phone={followup.phone} customerName={followup.business_name ?? followup.customer_name} />
          {followup.order_id ? (
            <a
              href="/admin/pedidos"
              className="inline-flex items-center rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
            >
              Abrir pedido
            </a>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-black/55">No hay seguimiento seleccionado.</p>
      )}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md bg-[#f4f4f5] px-3 py-2">
      <span className="text-xs font-medium uppercase text-black/50">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
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

function HelpCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-3 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-black/55">{text}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}

function CustomerSelect({
  customers,
  value,
  onChange,
}: {
  customers: AdminCrmData["customers"];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
    >
      <option value="">Seleccionar cliente</option>
      {customers.map((customer) => (
        <option key={customer.id} value={customer.id}>
          {customerDisplayName(customer)} - {customer.phone}
        </option>
      ))}
    </select>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f4f4f5]"
    >
      {children}
    </button>
  );
}

function LinkIconButton({ label, href, children }: { label: string; href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f4f4f5]"
    >
      {children}
    </Link>
  );
}



