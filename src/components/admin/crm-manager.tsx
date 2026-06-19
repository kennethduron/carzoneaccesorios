"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Archive,
  Ban,
  BadgeDollarSign,
  CalendarClock,
  CheckCircle2,
  Clock,
  Eye,
  ExternalLink,
  ListChecks,
  Mail,
  MessageSquarePlus,
  NotebookPen,
  PackageSearch,
  PhoneCall,
  Pencil,
  PlusCircle,
  ReceiptText,
  Save,
  Search,
  ShieldAlert,
  Target,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  archiveCrmNoteAction,
  approveWholesaleRequestAction,
  changeWholesaleCustomerTypeAction,
  deleteCustomerAccountPermanentlyAction,
  deleteTestAccountAction,
  getCustomerProfileAction,
  mergeDuplicateCustomerAction,
  reactivateCustomerAccountAction,
  reactivateWholesaleAccessAction,
  rejectWholesaleRequestAction,
  saveCrmFollowupAction,
  saveCrmLeadAction,
  saveCrmNoteAction,
  saveCustomerCommercialCreditAction,
  setCrmFollowupStatusAction,
  suspendCustomerAccountAction,
  suspendWholesaleAccessAction,
} from "@/app/admin/crm/actions";
import { registerCreditReceivablePaymentAction } from "@/app/admin/pedidos/actions";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { CreditPaymentHistory } from "@/components/admin/credit-payment-history";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { roleLabels } from "@/lib/auth/roles";
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
import type { AccountsReceivableRow, CommercialCreditPaymentReceivedMethod } from "@/types/credit";
import type { WholesaleCustomerType } from "@/types/wholesale";
import { isCashOnDeliveryPending } from "@/utils/cash-on-delivery";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { detailedPaymentMethodLabels, paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";

type CrmManagerProps = {
  data: AdminCrmData;
  basePath?: string;
  focus?: "customers" | "followups";
  activeTask?: { id: string; label: string } | null;
  canManageCredit?: boolean;
};

type CustomerFilter = "clients" | "internal" | "all" | "active" | "prospects" | "wholesale" | "wholesale_requests" | "suspended";

type DuplicateMergeRequest = {
  source: CrmDuplicateCandidate;
  target: CrmDuplicateCandidate;
};

type PermanentDeleteDraft = {
  customer: CrmCustomerOption;
  confirmation: string;
  errorMessage?: string;
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
  clients: "Clientes",
  internal: "Usuarios internos",
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
  ...detailedPaymentMethodLabels,
  card: "Tarjeta mediante enlace",
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

type CreditPaymentModalDraft = {
  amount: string;
  method: CommercialCreditPaymentReceivedMethod | "";
  reference: string;
  receivedAt: string;
  note: string;
  receiptUrl: string;
  idempotencyKey: string;
};

function todayInputValue() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function newCreditPaymentIdempotencyKey(receivableId: string) {
  const randomValue = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `credit-payment:${receivableId}:${randomValue}`;
}

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

function followupStatusClasses(followup: CrmFollowupRow) {
  if (isOverdue(followup)) {
    return "border-[#fed7aa] bg-[#fff7ed] text-[#9a3412]";
  }
  if (followup.status === "completed") {
    return "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]";
  }
  if (followup.status === "cancelled") {
    return "border-black/10 bg-[#f4f4f5] text-black/55";
  }
  return "border-[#bae6fd] bg-[#f0f9ff] text-[#075985]";
}

function priorityClasses(priority: CrmPriority) {
  if (priority === "urgente") {
    return "border-[#fecdd3] bg-[#fff1f2] text-[#be123c]";
  }
  if (priority === "alta") {
    return "border-[#fed7aa] bg-[#fff7ed] text-[#9a3412]";
  }
  if (priority === "media") {
    return "border-[#fde68a] bg-[#fffbeb] text-[#92400e]";
  }
  return "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]";
}

function cleanText(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function followupDisplayName(item: CrmFollowupRow) {
  return cleanText(item.business_name ?? item.customer_name, "Cliente o prospecto sin nombre");
}

function followupSecondaryName(item: CrmFollowupRow) {
  if (item.business_name && item.customer_name && item.business_name !== item.customer_name) {
    return item.customer_name;
  }
  return item.customer_profile_label;
}

export function CrmManager({
  data,
  basePath = "/admin/crm",
  focus = "followups",
  activeTask = null,
  canManageCredit = false,
}: CrmManagerProps) {
  const [query, setQuery] = useState("");
  const [lead, setLead] = useState<CrmLeadInput>(emptyLead);
  const [followup, setFollowup] = useState<CrmFollowupInput>(emptyFollowup);
  const [note, setNote] = useState<CrmNoteInput>(emptyNote);
  const [selectedCustomerId, setSelectedCustomerId] = useState(data.customers[0]?.id ?? "");
  const [selectedFollowupId, setSelectedFollowupId] = useState(data.followups[0]?.id ?? "");
  const [customerFilter, setCustomerFilter] = useState<CustomerFilter>("clients");
  const [followupStatusFilter, setFollowupStatusFilter] = useState<"all" | "pending" | "completed" | "cancelled" | "overdue">(
    activeTask?.id === "overdue" ? "overdue" : "all",
  );
  const [followupPriorityFilter, setFollowupPriorityFilter] = useState<"all" | CrmPriority>("all");
  const [followupTypeFilter, setFollowupTypeFilter] = useState<"all" | CrmInteractionType>("all");
  const [openLeadForm] = useState(false);
  const [openFollowupForm] = useState(false);
  const [openNoteForm] = useState(false);
  const [crmDrawer, setCrmDrawer] = useState<CrmDrawerMode>(null);
  const [mergeRequest, setMergeRequest] = useState<DuplicateMergeRequest | null>(null);
  const [permanentDeleteDraft, setPermanentDeleteDraft] = useState<PermanentDeleteDraft | null>(null);
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
      const matchesAudience =
        customerFilter === "internal"
          ? item.customer_profile_kind === "internal"
          : customerFilter === "all"
            ? true
            : item.customer_profile_kind === "customer";

      return matchesQuery && matchesStatus && matchesPriority && matchesType && matchesAudience;
    });
  }, [customerFilter, data.followups, debouncedQuery, followupPriorityFilter, followupStatusFilter, followupTypeFilter]);

  const searchedCustomers = useMemo(() => {
    const normalized = debouncedQuery.trim().toLowerCase();
    return data.customers.filter((customer) => {
      if (!normalized) {
        return true;
      }

      return `${customer.contact_name} ${customer.business_name ?? ""} ${customer.email ?? ""} ${customer.phone} ${customer.profile_label} ${customer.account_role ?? ""}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [data.customers, debouncedQuery]);

  const filteredCustomers = useMemo(
    () =>
      searchedCustomers.filter((customer) => {
        if (customerFilter === "clients") {
          return customer.profile_kind === "customer";
        }
        if (customerFilter === "internal") {
          return customer.profile_kind === "internal";
        }
        if (customerFilter === "active") {
          return customer.profile_kind === "customer" && (customer.account_state === "Cliente activo" || (customer.active && customer.status === "active"));
        }
        if (customerFilter === "prospects") {
          return customer.profile_kind === "customer" && customer.lead_status !== "cliente" && !customer.has_wholesale_request;
        }
        if (customerFilter === "wholesale") {
          return customer.profile_kind === "customer" && customer.is_wholesale;
        }
        if (customerFilter === "wholesale_requests") {
          return customer.profile_kind === "customer" && customer.has_wholesale_request && !customer.is_wholesale;
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
  const realCustomers = data.customers.filter((customer) => customer.profile_kind === "customer");
  const prospects = realCustomers.filter((customer) => customer.lead_status !== "cliente");
  const wholesaleRequests = realCustomers.filter((customer) => customer.notes?.includes("[SOLICITUD_MAYOREO]") && !customer.is_wholesale);
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
        monthly_amount: 0,
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
        monthly_amount: 0,
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

  function openNoteDrawerForCustomer(customer: CrmCustomerOption) {
    closeCustomerProfile();
    setNote({
      customer_id: customer.id,
      note_type: "nota",
      note: "",
    });
    setCrmDrawer("note");
  }

  function openNoteDrawerForCustomerId(customerId: string) {
    closeCustomerProfile();
    setNote({
      customer_id: customerId,
      note_type: "nota",
      note: "",
    });
    setCrmDrawer("note");
  }

  function openFollowupDrawerForCustomer(customer: CrmCustomerOption) {
    closeCustomerProfile();
    setFollowup({
      ...emptyFollowup,
      customer_id: customer.id,
      phone: customer.account_phone ?? customer.phone ?? "",
      title: "Contactar cliente",
      next_action: "Revisar necesidad del cliente y registrar avance.",
    });
    setCrmDrawer("followup");
  }

  function openFollowupDetail(item: CrmFollowupRow) {
    setSelectedFollowupId(item.id);
    setCrmDrawer("followup-detail");
  }

  function openCustomerProfileFromCrmDrawer(customerId: string) {
    setCrmDrawer(null);
    void openCustomerProfile(customerId);
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

  function approveWholesaleCustomer(customerId: string, wholesaleCustomerType: WholesaleCustomerType) {
    startTransition(async () => {
      const result = await approveWholesaleRequestAction(customerId, wholesaleCustomerType);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Mayorista aprobado correctamente.");
      } else {
        toast.error(result.message || "No se pudo aprobar el mayorista.");
      }
    });
  }

  async function changeWholesaleCustomerType(customer: CrmCustomerOption, wholesaleCustomerType: WholesaleCustomerType) {
    const confirmed = await toast.confirm({
      title: "Cambiar tipo mayorista",
      message: "Cambiar el tipo mayorista puede afectar la regla de primera compra mínima. ¿Deseas continuar?",
      confirmLabel: "Cambiar tipo",
      cancelLabel: "Cancelar",
      tone: "neutral",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await changeWholesaleCustomerTypeAction(customer.id, wholesaleCustomerType);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  async function rejectWholesaleCustomer(customer: CrmCustomerOption) {
    closeActiveCustomerWindows(customer.id);
    const confirmed = await toast.confirm({
      title: "Rechazar solicitud mayorista",
      message: `¿Rechazar la solicitud mayorista de ${customerDisplayName(customer)}? El cliente conservará su cuenta normal.`,
      confirmLabel: "Rechazar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await rejectWholesaleRequestAction(customer.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Solicitud mayorista rechazada.");
      } else {
        toast.error(result.message || "No se pudo rechazar la solicitud mayorista.");
      }
    });
  }

  async function suspendWholesaleCustomer(customer: CrmCustomerOption) {
    closeActiveCustomerWindows(customer.id);
    const confirmed = await toast.confirm({
      title: "Suspender acceso mayorista",
      message: `¿Suspender el acceso mayorista de ${customerDisplayName(customer)}? La cuenta seguirá existiendo, pero no tendrá precios mayoristas.`,
      confirmLabel: "Suspender",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await suspendWholesaleAccessAction(customer.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Acceso mayorista suspendido.");
      } else {
        toast.error(result.message || "No se pudo suspender el acceso mayorista.");
      }
    });
  }

  async function reactivateWholesaleCustomer(customer: CrmCustomerOption) {
    closeActiveCustomerWindows(customer.id);
    const confirmed = await toast.confirm({
      title: "Reactivar acceso mayorista",
      message: `¿Reactivar el acceso mayorista de ${customerDisplayName(customer)}?`,
      confirmLabel: "Reactivar",
      cancelLabel: "Cancelar",
      tone: "neutral",
    });

    if (!confirmed) {
      return;
    }

    startTransition(async () => {
      const result = await reactivateWholesaleAccessAction(customer.id);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Acceso mayorista reactivado.");
      } else {
        toast.error(result.message || "No se pudo reactivar el acceso mayorista.");
      }
    });
  }

  async function suspendCustomer(customer: CrmCustomerOption) {
    closeActiveCustomerWindows(customer.id);
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
    closeActiveCustomerWindows(customer.id);
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

    closeActiveCustomerWindows(customer.id);
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

  function requestPermanentDeleteCustomer(customer: CrmCustomerOption) {
    if (!customer.can_delete_permanently) {
      toast.warning(customer.delete_block_reason || "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla.");
      return;
    }

    setCrmDrawer(null);
    closeCustomerProfile();
    setPermanentDeleteDraft({ customer, confirmation: "" });
  }

  function confirmPermanentDeleteCustomer() {
    if (!permanentDeleteDraft) {
      return;
    }

    const customer = permanentDeleteDraft.customer;
    startTransition(async () => {
      const result = await deleteCustomerAccountPermanentlyAction({
        customerId: customer.id,
        confirmation: permanentDeleteDraft.confirmation,
        reason: "Eliminación permanente confirmada desde gestión de clientes.",
      });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Cuenta eliminada permanentemente.");
        setPermanentDeleteDraft(null);
        closeCustomerProfile();
      } else {
        const errorMessage = result.message || "No se pudo eliminar la cuenta.";
        setPermanentDeleteDraft((current) => (current ? { ...current, errorMessage } : current));
        toast.error(errorMessage);
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

  function closeActiveCustomerWindows(customerId?: string) {
    setCrmDrawer(null);
    if (!customerId || profileCustomerId === customerId) {
      closeCustomerProfile();
    }
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
      {activeTask ? <ActiveFilterBanner label={activeTask.label} clearHref={basePath} /> : null}

      <PaginationControls
        basePath={basePath}
        page={focus === "customers" ? data.customerPage : data.followupPage}
        pageSize={data.pageSize}
        total={focus === "customers" ? data.customersTotal : data.followupsTotal}
        label={focus === "customers" ? "clientes" : "seguimientos"}
        params={activeTask ? { task: activeTask.id } : undefined}
      />

      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="Prospectos" value={prospects.length.toLocaleString("es-HN")} />
        <Metric label="Pendientes" value={pendingFollowups.length.toLocaleString("es-HN")} />
        <Metric label="Atrasados" value={overdueCount.toLocaleString("es-HN")} />
        <Metric label="Solicitudes de mayoreo" value={wholesaleRequests.length.toLocaleString("es-HN")} />
        <Metric label="Pipeline estimado" value={formatCurrency(estimatedPipeline)} />
      </div>

      {focus !== "customers" ? (
        <CrmPurposePanel />
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
            <Field label="Correo electrónico">
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
            <Field label="Título">
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
            onDeleteCustomer={requestPermanentDeleteCustomer}
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
            key={profileCustomerId ?? "customer-profile-closed"}
            open={Boolean(profileCustomerId)}
            profile={customerProfile}
            fallbackCustomer={data.customers.find((customer) => customer.id === profileCustomerId) ?? selectedCustomer}
            loading={profileLoading}
            error={profileError}
            pending={isPending}
            canManageCredit={canManageCredit}
            onProfileUpdated={setCustomerProfile}
            onClose={closeCustomerProfile}
            onApproveWholesale={approveWholesaleCustomer}
            onChangeWholesaleType={changeWholesaleCustomerType}
            onRejectWholesale={rejectWholesaleCustomer}
            onSuspendWholesale={suspendWholesaleCustomer}
            onReactivateWholesale={reactivateWholesaleCustomer}
            onSuspend={suspendCustomer}
            onReactivate={reactivateCustomer}
            onDeleteTest={deleteTestCustomer}
            onDeleteCustomer={requestPermanentDeleteCustomer}
            onAddNote={openNoteDrawerForCustomer}
            onCreateFollowup={openFollowupDrawerForCustomer}
            onCompleteFollowup={(id) => setStatus(id, "completed")}
          />
        </div>
      ) : null}

      {focus !== "customers" ? (
      <div className="space-y-4">
      <CustomerFilterTabs value={customerFilter} onChange={setCustomerFilter} />
      <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <div className="overflow-hidden rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-5">
            <h2 className="font-semibold">Historial CRM</h2>
            <p className="mt-1 text-sm text-black/55">
              {filteredFollowups.length.toLocaleString("es-HN")} seguimientos en esta página. Usa este historial para ver llamadas, notas, tareas pendientes y oportunidades comerciales sin perder contexto.
            </p>
          </div>
          <FollowupHistoryList
            followups={filteredFollowups}
            customers={data.customers}
            pending={isPending}
            onComplete={(id) => setStatus(id, "completed")}
            onArchive={(id) => setStatus(id, "cancelled")}
            onEdit={openFollowupDrawer}
            onAddNote={openNoteDrawerForCustomerId}
            onOpenDetail={openFollowupDetail}
          />
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
            onDeleteCustomer={requestPermanentDeleteCustomer}
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
      </div>
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
          onViewCustomer={openCustomerProfileFromCrmDrawer}
        />
      ) : null}
      {focus !== "customers" ? (
        <CustomerProfileDrawer
          key={profileCustomerId ?? "customer-profile-closed"}
          open={Boolean(profileCustomerId)}
          profile={customerProfile}
          fallbackCustomer={data.customers.find((customer) => customer.id === profileCustomerId) ?? selectedCustomer}
          loading={profileLoading}
          error={profileError}
          pending={isPending}
          canManageCredit={canManageCredit}
          onProfileUpdated={setCustomerProfile}
          onClose={closeCustomerProfile}
          onApproveWholesale={approveWholesaleCustomer}
          onChangeWholesaleType={changeWholesaleCustomerType}
          onRejectWholesale={rejectWholesaleCustomer}
          onSuspendWholesale={suspendWholesaleCustomer}
          onReactivateWholesale={reactivateWholesaleCustomer}
          onSuspend={suspendCustomer}
          onReactivate={reactivateCustomer}
          onDeleteTest={deleteTestCustomer}
          onDeleteCustomer={requestPermanentDeleteCustomer}
          onAddNote={openNoteDrawerForCustomer}
          onCreateFollowup={openFollowupDrawerForCustomer}
          onCompleteFollowup={(id) => setStatus(id, "completed")}
        />
      ) : null}
      {permanentDeleteDraft ? (
        <PermanentDeleteAccountModal
          draft={permanentDeleteDraft}
          pending={isPending}
          onCancel={() => setPermanentDeleteDraft(null)}
          onChange={(confirmation) =>
            setPermanentDeleteDraft((current) => (current ? { ...current, confirmation, errorMessage: undefined } : current))
          }
          onConfirm={confirmPermanentDeleteCustomer}
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
    <div className="cz-layer-drawer fixed inset-0 bg-black/45 backdrop-blur-sm" onClick={() => void onClose()}>
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
            <div className="space-y-4 text-sm">
              <section className="rounded-lg border border-black/10 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase text-[#e4252c]">Seguimiento</p>
                    <h3 className="mt-1 text-lg font-semibold">{selectedFollowup.title}</h3>
                    <p className="mt-1 text-black/55">{selectedFollowup.business_name ?? selectedFollowup.customer_name ?? "Cliente"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <InfoPill>{followupStatusLabel(selectedFollowup)}</InfoPill>
                    <InfoPill>{priorityLabels[selectedFollowup.priority]}</InfoPill>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => onViewCustomer(selectedFollowup.customer_id)}>
                    Ver cliente
                  </Button>
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => onEditFollowup(selectedFollowup)}>
                    Editar
                  </Button>
                  {selectedFollowup.status === "pending" ? (
                    <Button type="button" variant="dark" disabled={pending} onClick={() => onCompleteFollowup(selectedFollowup.id)}>
                      Marcar completado
                    </Button>
                  ) : null}
                </div>
              </section>
              <section className="grid gap-3 sm:grid-cols-2">
                <InfoLine label="Tipo" value={interactionLabels[selectedFollowup.interaction_type]} />
                <InfoLine label="Fecha" value={formatDateTime(selectedFollowup.due_at)} />
                <InfoLine label="Próxima acción" value={selectedFollowup.next_action ?? "-"} />
                <InfoLine label="Teléfono" value={selectedFollowup.phone ?? "Sin teléfono"} />
              </section>
              {selectedFollowup.notes ? (
                <section className="rounded-lg border border-black/10 bg-white p-4">
                  <p className="text-xs font-semibold uppercase text-black/50">Notas</p>
                  <p className="mt-2 whitespace-pre-line text-black/70">{selectedFollowup.notes}</p>
                </section>
              ) : null}
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

function PermanentDeleteAccountModal({
  draft,
  pending,
  onCancel,
  onChange,
  onConfirm,
}: {
  draft: PermanentDeleteDraft;
  pending: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onConfirm: () => void;
}) {
  const customer = draft.customer;
  const email = customer.account_email ?? customer.email ?? "Sin correo";
  const phone = customer.account_phone ?? customer.phone ?? "Sin teléfono";
  const canConfirm = draft.confirmation.trim() === "ELIMINAR CUENTA";

  return (
    <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4 py-6">
      <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 text-[#080808] shadow-xl">
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
            <Trash2 size={22} />
          </div>
          <div>
            <h2 className="text-xl font-semibold">Eliminar cuenta permanentemente</h2>
            <p className="mt-2 text-sm leading-6 text-black/65">
              Esta acción eliminará la cuenta del cliente y permitirá que el correo pueda registrarse nuevamente. Esta acción no se puede deshacer.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-2 rounded-lg border border-black/10 bg-[#f4f4f5] p-4 text-sm sm:grid-cols-2">
          <InfoLine label="Nombre" value={customerDisplayName(customer)} />
          <InfoLine label="Correo electrónico" value={email} />
          <InfoLine label="Teléfono" value={phone} />
          <InfoLine label="Rol" value="Cliente" />
          <InfoLine label="Estado" value={customer.account_state} />
          <InfoLine label="Fecha de creación" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
        </div>

        <label className="mt-5 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Confirmación requerida</span>
          <input
            value={draft.confirmation}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            placeholder="Escribe ELIMINAR CUENTA"
            autoFocus
          />
        </label>

        <div className="mt-4 rounded-md border border-[#f59e0b]/30 bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          Si el backend detecta pedidos, facturas, pagos, reservas, comprobantes o historial fiscal, bloqueará la eliminación y solo permitirá suspender.
        </div>

        {draft.errorMessage ? (
          <div className="mt-4 rounded-md border border-[#f2b8a8] bg-[#fff6f2] p-3 text-sm font-medium text-[#7c2d12]" role="alert">
            {draft.errorMessage}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" variant="secondary" disabled={pending || !canConfirm} onClick={onConfirm}>
            <Trash2 size={16} />
            {pending ? "Eliminando..." : "Eliminar permanentemente"}
          </Button>
        </div>
      </section>
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
    <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4 py-6">
      <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 text-[#080808] shadow-xl">
        <h2 className="text-xl font-semibold">Unificar cliente duplicado</h2>
        <p className="mt-2 text-sm leading-6 text-black/65">
          Este registro se unirá al cliente principal. Sus pedidos, notas, seguimientos y estado mayorista se moverán al perfil principal.
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

type CustomerProfileTab = "resumen" | "informacion" | "compras" | "facturas" | "crm" | "credito" | "mayorista" | "acciones";

const customerProfileTabs: Array<{ id: CustomerProfileTab; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "informacion", label: "Información" },
  { id: "compras", label: "Compras" },
  { id: "facturas", label: "Facturas" },
  { id: "crm", label: "CRM" },
  { id: "credito", label: "Crédito" },
  { id: "mayorista", label: "Mayorista" },
  { id: "acciones", label: "Acciones" },
];

const internalProfileTabs: Array<{ id: CustomerProfileTab; label: string }> = [
  { id: "resumen", label: "Resumen operativo" },
  { id: "informacion", label: "Información" },
  { id: "compras", label: "Compras personales" },
  { id: "facturas", label: "Facturas vinculadas" },
  { id: "acciones", label: "Seguridad" },
];

function CustomerProfileDrawer({
  open,
  profile,
  fallbackCustomer,
  loading,
  error,
  pending,
  canManageCredit,
  onProfileUpdated,
  onClose,
  onApproveWholesale,
  onChangeWholesaleType,
  onRejectWholesale,
  onSuspendWholesale,
  onReactivateWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
  onDeleteCustomer,
  onAddNote,
  onCreateFollowup,
  onCompleteFollowup,
}: {
  open: boolean;
  profile: CrmCustomerProfile | null;
  fallbackCustomer: CrmCustomerOption | null;
  loading: boolean;
  error: string | null;
  pending: boolean;
  canManageCredit: boolean;
  onProfileUpdated: (profile: CrmCustomerProfile) => void;
  onClose: () => void;
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onChangeWholesaleType: (customer: CrmCustomerOption, wholesaleCustomerType: WholesaleCustomerType) => void;
  onRejectWholesale: (customer: CrmCustomerOption) => void;
  onSuspendWholesale: (customer: CrmCustomerOption) => void;
  onReactivateWholesale: (customer: CrmCustomerOption) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
  onDeleteCustomer: (customer: CrmCustomerOption) => void;
  onAddNote: (customer: CrmCustomerOption) => void;
  onCreateFollowup: (customer: CrmCustomerOption) => void;
  onCompleteFollowup: (id: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<CustomerProfileTab>("resumen");
  const customer = profile?.customer ?? fallbackCustomer;
  const profileTabs =
    customer?.profile_kind === "internal"
      ? internalProfileTabs
      : customerProfileTabs.filter((tab) => tab.id !== "credito" || canManageCredit);
  const visibleActiveTab = profileTabs.some((tab) => tab.id === activeTab) ? activeTab : "resumen";
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
    <div className="cz-layer-drawer fixed inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={customer?.profile_kind === "internal" ? "Perfil de usuario interno" : "Perfil completo del cliente"}
        className="ml-auto flex h-full w-full flex-col bg-[#f4f4f5] text-[#080808] shadow-2xl md:max-w-[min(1180px,96vw)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-black/10 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-[#e4252c]">
                {customer?.profile_kind === "internal" ? "Perfil operativo" : "Perfil completo"}
              </p>
              <h2 className="mt-1 truncate text-xl font-semibold">{customer ? customerDisplayName(customer) : "Cargando cliente"}</h2>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {customer ? (
                  <>
                    {customer.primary_badges.map((badge) => (
                      <span key={badge} className="rounded-md bg-[#fff1f2] px-2 py-1 font-semibold text-[#b91c25]">
                        {badge}
                      </span>
                    ))}
                    <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-black/60">{customer.account_state}</span>
                    {customer.profile_kind === "customer" && isWholesaleRequest && !customer.is_wholesale ? (
                      <span className="rounded-md bg-[#fff7ed] px-2 py-1 text-[#7c2d12]">Solicitud mayorista</span>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              {customer ? (
                <>
                  <ContactActions phone={customer.account_phone ?? customer.phone} customerName={customerDisplayName(customer)} />
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => onAddNote(customer)}>
                    <MessageSquarePlus size={16} />
                    Agregar nota
                  </Button>
                  {customer.profile_kind === "customer" ? (
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => onCreateFollowup(customer)}>
                      <Clock size={16} />
                      Crear seguimiento
                    </Button>
                  ) : null}
                </>
              ) : null}
              <button
                type="button"
                aria-label="Cerrar perfil del cliente"
                onClick={onClose}
                className="grid size-10 shrink-0 place-items-center rounded-md border border-black/10 bg-white text-black/60 transition-colors hover:bg-[#f4f4f5] hover:text-[#080808]"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <nav className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {profileTabs.map((tab) => {
              const active = visibleActiveTab === tab.id;
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
              {visibleActiveTab === "resumen" ? <CustomerProfileSummary profile={profile} /> : null}
              {visibleActiveTab === "informacion" ? <CustomerProfileInfo customer={customer} /> : null}
              {visibleActiveTab === "compras" ? <CustomerProfilePurchases orders={profile.orders} /> : null}
              {visibleActiveTab === "facturas" ? <CustomerProfileInvoices invoices={profile.invoices} /> : null}
              {customer.profile_kind === "customer" && visibleActiveTab === "crm" ? (
                <CustomerProfileCrm
                  customer={customer}
                  notes={profile.notes}
                  followups={profile.followups}
                  pending={pending}
                  onAddNote={onAddNote}
                  onCreateFollowup={onCreateFollowup}
                  onCompleteFollowup={onCompleteFollowup}
                />
              ) : null}
              {customer.profile_kind === "customer" && canManageCredit && visibleActiveTab === "credito" ? (
                <CustomerProfileCredit
                  profile={profile}
                  onProfileUpdated={onProfileUpdated}
                />
              ) : null}
              {customer.profile_kind === "customer" && visibleActiveTab === "mayorista" ? (
                <CustomerProfileWholesale
                  profile={profile}
                  pending={pending}
                  onApproveWholesale={onApproveWholesale}
                  onChangeWholesaleType={onChangeWholesaleType}
                  onRejectWholesale={onRejectWholesale}
                  onSuspendWholesale={onSuspendWholesale}
                  onReactivateWholesale={onReactivateWholesale}
                />
              ) : null}
              {visibleActiveTab === "acciones" ? (
                <CustomerProfileActions
                  customer={customer}
                  pending={pending}
                  isWholesaleRequest={isWholesaleRequest}
                  isSuspended={isSuspended}
                  onApproveWholesale={onApproveWholesale}
                  onAddNote={onAddNote}
                  onCreateFollowup={onCreateFollowup}
                  onSuspend={onSuspend}
                  onReactivate={onReactivate}
                  onDeleteTest={onDeleteTest}
                  onDeleteCustomer={onDeleteCustomer}
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
  const pendingFollowups = profile.followups.filter((followup) => followup.status === "pending").slice(0, 3);
  const recentNotes = profile.notes.slice(0, 3);

  if (customer.profile_kind === "internal") {
    const roleLabel = customer.account_role ? roleLabels[customer.account_role] : customer.profile_label;
    const managedOrders = profile.orders.slice(0, 5);

    return (
      <div className="space-y-4">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Rol" value={roleLabel} />
          <Metric label="Estado" value={customer.account_active === false || !customer.active ? "Suspendido" : "Activo"} />
          <Metric label="Permisos" value={customer.account_role === "business_owner" ? "Acceso empresarial" : "Acceso operativo"} />
          <Metric label="Auditoría" value={customer.last_activity_at ? "Con actividad" : "Sin actividad"} />
        </section>
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <CustomerProfileInfo customer={customer} compact />
          <section className="rounded-lg border border-black/10 bg-white p-5">
            <h3 className="font-semibold">{customer.account_role === "business_owner" ? "Dashboard empresarial" : "Actividad reciente"}</h3>
            <div className="mt-4 space-y-3">
              <InfoLine label="Identidad principal" value={customer.account_role === "business_owner" ? "Dueno operativo" : "Usuario interno"} />
              <InfoLine label="Actividad administrativa" value={recentNotes.length > 0 ? "Con registros vinculados" : "Sin registros recientes"} />
              <InfoLine label="Pedidos gestionados" value={customer.order_count.toLocaleString("es-HN")} />
              <InfoLine label="Facturas vinculadas" value={customer.invoice_count.toLocaleString("es-HN")} />
            </div>
          </section>
        </div>
        <CustomerProfilePurchases orders={managedOrders} compact title="Compras personales vinculadas" empty="Este usuario interno no tiene compras personales vinculadas." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Total comprado" value={formatCurrency(customer.total_spent)} />
        <Metric label="Pedidos" value={customer.order_count.toLocaleString("es-HN")} />
        <Metric label="Facturas" value={customer.invoice_count.toLocaleString("es-HN")} />
        <Metric label="Pendientes CRM" value={pendingFollowups.length.toLocaleString("es-HN")} />
      </section>
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <CustomerProfileInfo customer={customer} compact />
        <section className="rounded-lg border border-black/10 bg-white p-5">
          <h3 className="font-semibold">Actividad reciente</h3>
          <div className="mt-4 space-y-3">
            {recentNotes.length === 0 && pendingFollowups.length === 0 ? (
              <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">Este cliente todavía no tiene actividad CRM reciente.</p>
            ) : (
              <>
                {pendingFollowups.map((followup) => (
                  <article key={followup.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                    <p className="font-semibold">{followup.title}</p>
                    <p className="mt-1 text-xs text-black/50">{followup.next_action ?? "Seguimiento pendiente"} - {formatDateTime(followup.due_at)}</p>
                  </article>
                ))}
                {recentNotes.map((note) => (
                  <article key={note.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                    <p className="line-clamp-2 text-black/70">{note.note}</p>
                    <p className="mt-1 text-xs text-black/45">{formatDateTime(note.created_at)}</p>
                  </article>
                ))}
              </>
            )}
          </div>
        </section>
      </div>
      <CustomerProfilePurchases orders={profile.orders.slice(0, 5)} compact />
    </div>
  );
}

function CustomerProfileInfo({ customer, compact = false }: { customer: CrmCustomerOption; compact?: boolean }) {
  if (customer.profile_kind === "internal") {
    return (
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h3 className="font-semibold">Información operativa</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <InfoLine label="Nombre" value={customerDisplayName(customer)} />
          <InfoLine label="Usuario" value={customer.account_full_name ?? customerDisplayName(customer)} />
          <InfoLine label="Correo electrónico" value={customer.account_email ?? customer.email ?? "Sin correo electrónico"} />
        <InfoLine label="Teléfono" value={customer.account_phone ?? customer.phone ?? "Sin teléfono"} />
          <InfoLine label="Rol" value={customer.account_role ? roleLabels[customer.account_role] : customer.profile_label} />
          <InfoLine label="Estado" value={customer.account_active === false || !customer.active ? "Suspendido" : "Activo"} />
          <InfoLine label="Fecha de creación" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
          <InfoLine label="Último acceso" value={formatDateTime(customer.last_activity_at)} />
          {!compact ? (
            <InfoLine
              label="Acceso"
              value={customer.account_role === "business_owner" ? "Gestión completa del negocio" : "Permisos operativos por rol"}
            />
          ) : null}
          {!compact ? <InfoLine label="Compras" value="Compras personales vinculadas en una sección secundaria" /> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="font-semibold">Información general</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <InfoLine label="Nombre" value={customerDisplayName(customer)} />
        <InfoLine label="Correo electrónico" value={customer.account_email ?? customer.email ?? "Sin correo electrónico"} />
        <InfoLine label="Teléfono" value={customer.account_phone ?? customer.phone ?? "Sin teléfono"} />
        <InfoLine label="Ciudad" value={customer.city ?? "Sin ciudad"} />
        <InfoLine label="RTN" value={customer.tax_id ?? "Sin RTN"} />
        <InfoLine label="Tipo de cliente" value={customer.customer_type === "Retail" ? "Cliente al detalle" : "Mayorista"} />
        <InfoLine label="Estado de cuenta" value={customer.account_state} />
        <InfoLine label="Mayorista" value={customer.is_wholesale ? "Aprobado" : customer.has_wholesale_request ? "Solicitud pendiente" : "No aprobado"} />
        <InfoLine label="Fecha de registro" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
        <InfoLine label="Última actividad" value={formatDateTime(customer.last_activity_at)} />
        {!compact ? <InfoLine label="Correo electrónico confirmado" value={customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"} /> : null}
        {!compact ? <InfoLine label="Estado CRM" value={leadStatusLabels[customer.lead_status]} /> : null}
      </div>
    </section>
  );
}

function paymentStatusLabel(value: string | null | undefined) {
  if (!value) {
    return "Sin pago";
  }

  const labels: Record<string, string> = {
    pending: "Pendiente",
    pendiente: "Pendiente",
    paid: "Pagado",
    pagado: "Pagado",
    confirmed: "Confirmado",
    confirmado: "Confirmado",
    rejected: "Rechazado",
    rechazado: "Rechazado",
    cancelled: "Cancelado",
    cancelado: "Cancelado",
  };

  return labels[value] ?? value;
}

function CustomerProfilePurchases({
  orders,
  compact = false,
  title = "Historial de compras",
  empty = "Este cliente todavía no tiene compras.",
}: {
  orders: CrmCustomerProfile["orders"];
  compact?: boolean;
  title?: string;
  empty?: string;
}) {
  return (
    <ProfileTableCard title={title} empty={empty}>
      {orders.map((order) => (
        <ProfileRow key={order.id} columns="purchase">
          <div>
            <p className="font-semibold">{order.order_number}</p>
            <p className="text-xs text-black/45">{formatDateTime(order.created_at)}</p>
          </div>
          <InfoPill>{orderStatusLabels[order.status] ?? order.status}</InfoPill>
          <div className="text-sm">
            <p>{paymentMethodLabels[order.payment_method] ?? paymentMethodLabel(order.payment_method, { detailedCard: true })}</p>
            <p className="text-xs text-black/45">{paymentStatusLabel(order.payment_status)}</p>
            {order.payment_method === "bank_transfer" ? (
              <p className="text-xs text-black/45">
                Ref: {order.bank_reference_number ?? "Sin referencia"} /{" "}
                {order.has_transfer_receipt ? "Con comprobante" : "Sin comprobante adjunto"}
              </p>
            ) : null}
          </div>
          <div className="text-sm">
            <p className="font-semibold">{formatCurrency(order.total)}</p>
            <p className="text-xs text-black/45">
              Sub {formatCurrency(order.subtotal)} / ISV {formatCurrency(order.tax)}
            </p>
            <p className="text-xs text-black/45">
              Env {formatCurrency(order.shipping_fee)} / CE{" "}
              {isCashOnDeliveryPending(order.payment_method, order.payment_timing, order.cash_on_delivery_fee)
                ? "pendiente"
                : formatCurrency(order.cash_on_delivery_fee)}
            </p>
            <p className="text-xs text-black/45">
              Rec {formatCurrency(order.small_order_fee + order.additional_fees_total)} / Desc {formatCurrency(order.discount_total)}
            </p>
          </div>
          <p className="text-sm">
            {order.invoice_number
              ? order.invoice_status === "anulada" || order.invoice_status === "cancelled"
                ? `${order.invoice_number} anulada`
                : order.invoice_number
              : "Sin factura"}
          </p>
          <Link href="/admin/pedidos" className="text-sm font-semibold text-[#e4252c] hover:text-[#b91c25]">
            Ver pedido
          </Link>
        </ProfileRow>
      ))}
      {orders.length === 0 ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-black/10 pt-3">
          <p className="text-xs text-black/45">Se muestran las últimas {orders.length} compras relacionadas.</p>
          {!compact ? (
            <Link href="/admin/pedidos" className="text-xs font-semibold text-[#e4252c] hover:text-[#b91c25]">
              Ver todos los pedidos
            </Link>
          ) : null}
        </div>
      )}
    </ProfileTableCard>
  );
}

function CustomerProfileInvoices({ invoices, compact = false }: { invoices: CrmCustomerProfile["invoices"]; compact?: boolean }) {
  return (
    <ProfileTableCard title="Facturas" empty="Este cliente todavía no tiene facturas.">
      {invoices.map((invoice) => (
        <ProfileRow key={invoice.id}>
          <div>
            <p className="font-semibold">{invoice.invoice_number}</p>
            <p className="text-xs text-black/45">{formatDateTime(invoice.issued_at ?? invoice.created_at)}</p>
          </div>
          <InfoPill>{invoice.status === "anulada" || invoice.status === "cancelled" ? "Anulada" : invoice.status}</InfoPill>
          <p className="text-sm">{invoice.order_number ?? "Sin pedido"}</p>
          <div className="text-sm">
            <p className="font-semibold">{formatCurrency(invoice.total)}</p>
            <p className="text-xs text-black/45">
              Sub {formatCurrency(invoice.subtotal)} / ISV {formatCurrency(invoice.tax)}
            </p>
            <p className="text-xs text-black/45">
              Env {formatCurrency(invoice.shipping_fee)} / CE {formatCurrency(invoice.cash_on_delivery_fee)}
            </p>
            <p className="text-xs text-black/45">
              Rec {formatCurrency(invoice.small_order_fee + invoice.additional_fees_total)} / Desc {formatCurrency(invoice.discount_total)}
            </p>
          </div>
          <Link href="/admin/facturas" className="text-sm font-semibold text-[#e4252c] hover:text-[#b91c25]">
            Ver factura
          </Link>
        </ProfileRow>
      ))}
      {invoices.length > 0 && !compact ? (
        <Link href="/admin/facturas" className="mt-3 inline-flex text-xs font-semibold text-[#e4252c] hover:text-[#b91c25]">
          Ver todas las facturas
        </Link>
      ) : null}
    </ProfileTableCard>
  );
}

function CustomerProfileCrm({
  customer,
  notes,
  followups,
  pending,
  onAddNote,
  onCreateFollowup,
  onCompleteFollowup,
  compact = false,
}: {
  customer: CrmCustomerOption;
  notes: CrmNoteRow[];
  followups: CrmFollowupRow[];
  pending: boolean;
  onAddNote: (customer: CrmCustomerOption) => void;
  onCreateFollowup: (customer: CrmCustomerOption) => void;
  onCompleteFollowup: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Seguimientos</h3>
          {!compact ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onCreateFollowup(customer)}>
              <Clock size={16} />
              Crear seguimiento
            </Button>
          ) : null}
        </div>
        <div className="mt-4 space-y-3">
          {followups.length === 0 ? (
            <p className="text-sm text-black/55">Este cliente todavía no tiene seguimientos.</p>
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
                {!compact && followup.status === "pending" ? (
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => onCompleteFollowup(followup.id)} className="mt-3">
                    <CheckCircle2 size={16} />
                    Completar seguimiento
                  </Button>
                ) : null}
              </article>
            ))
          )}
        </div>
        {followups.length > 4 && compact ? <p className="mt-3 text-xs text-black/45">Ver todos en la pestaña CRM.</p> : null}
      </section>
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Notas</h3>
          {!compact ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onAddNote(customer)}>
              <MessageSquarePlus size={16} />
              Agregar nota
            </Button>
          ) : null}
        </div>
        <div className="mt-4 space-y-3">
          {notes.length === 0 ? (
            <p className="text-sm text-black/55">Este cliente todavía no tiene notas.</p>
          ) : (
            notes.map((note) => (
              <article key={note.id} className="rounded-md bg-[#f4f4f5] p-3 text-sm">
                <p className="whitespace-pre-line text-black/70">{note.note}</p>
                <p className="mt-2 text-xs text-black/45">{formatDateTime(note.created_at)}</p>
              </article>
            ))
          )}
        </div>
        {notes.length > 4 && compact ? <p className="mt-3 text-xs text-black/45">Ver todas en la pestaña CRM.</p> : null}
      </section>
    </div>
  );
}

function CustomerProfileCredit({
  profile,
  onProfileUpdated,
}: {
  profile: CrmCustomerProfile;
  onProfileUpdated: (profile: CrmCustomerProfile) => void;
}) {
  const account = profile.creditAccount;
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(account?.is_credit_enabled ?? false);
  const [creditLimit, setCreditLimit] = useState(String(account?.credit_limit ?? 0));
  const [termsDays, setTermsDays] = useState(String(account?.terms_days ?? 30));
  const [status, setStatus] = useState<"active" | "suspended">(account?.status ?? "active");
  const [selectedReceivable, setSelectedReceivable] = useState<AccountsReceivableRow | null>(null);
  const [paymentDraft, setPaymentDraft] = useState<CreditPaymentModalDraft | null>(null);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);
  const isSubmittingPaymentRef = useRef(false);
  const pendingReceivables = profile.receivables.filter((item) => item.status !== "paid" && item.status !== "cancelled");
  const totalCreditUsed = profile.receivables.reduce((sum, item) => sum + item.original_amount, 0);
  const totalCreditPaid = profile.receivables.reduce((sum, item) => sum + item.total_paid, 0);
  const pendingBalance = pendingReceivables.reduce((sum, item) => sum + item.balance_due, 0);
  const availableCredit = Math.max(Number(creditLimit || 0) - pendingBalance, 0);
  const receivablesWithOrders = profile.receivables.map((item) => ({
    item,
    order: profile.orders.find((candidate) => candidate.id === item.order_id) ?? null,
  }));
  const creditStatusLabel: Record<string, string> = {
    open: "Abierto",
    partial: "Pago parcial",
    paid: "Pagado",
    overdue: "Vencido",
    cancelled: "Cancelado",
  };

  function saveCredit() {
    startTransition(async () => {
      const result = await saveCustomerCommercialCreditAction({
        customerId: profile.customer.id,
        isCreditEnabled: enabled,
        creditLimit: Number(creditLimit),
        termsDays: Number(termsDays),
        status,
        notes: account?.notes ?? "",
      });

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      const refreshed = await getCustomerProfileAction(profile.customer.id);
      if (refreshed.ok && refreshed.profile) {
        onProfileUpdated(refreshed.profile);
      }
      toast.success(result.message);
    });
  }

  function openPaymentModal(receivable: AccountsReceivableRow) {
    isSubmittingPaymentRef.current = false;
    setIsSubmittingPayment(false);
    setSelectedReceivable(receivable);
    setPaymentDraft({
      amount: "",
      method: "",
      reference: "",
      receivedAt: todayInputValue(),
      note: "",
      receiptUrl: "",
      idempotencyKey: newCreditPaymentIdempotencyKey(receivable.id),
    });
  }

  function closePaymentModal() {
    if (isPending || isSubmittingPaymentRef.current) return;
    isSubmittingPaymentRef.current = false;
    setIsSubmittingPayment(false);
    setSelectedReceivable(null);
    setPaymentDraft(null);
  }

  function registerPayment() {
    if (!selectedReceivable || !paymentDraft) return;
    if (isSubmittingPaymentRef.current) return;

    const amount = Math.round(Number(paymentDraft.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("El abono debe ser mayor que cero.");
      return;
    }

    if (amount > selectedReceivable.balance_due) {
      toast.error("El abono no puede ser mayor que el saldo pendiente de este pedido.");
      return;
    }

    if (!paymentDraft.method) {
      toast.error("Selecciona el método de pago del abono.");
      return;
    }
    const paymentMethod = paymentDraft.method;

    isSubmittingPaymentRef.current = true;
    setIsSubmittingPayment(true);

    startTransition(async () => {
      const result = await registerCreditReceivablePaymentAction({
        receivableId: selectedReceivable.id,
        amount,
        paymentMethod,
        paymentReference: paymentDraft.reference,
        receivedAt: paymentDraft.receivedAt,
        note: paymentDraft.note,
        receiptUrl: paymentDraft.receiptUrl,
        idempotencyKey: paymentDraft.idempotencyKey,
      }).catch(() => ({
        ok: false as const,
        message: "No se pudo registrar el abono. Inténtalo de nuevo.",
      }));

      isSubmittingPaymentRef.current = false;
      setIsSubmittingPayment(false);

      if (!result.ok) {
        setPaymentDraft((current) => (current ? { ...current, idempotencyKey: newCreditPaymentIdempotencyKey(selectedReceivable.id) } : current));
        toast.error(result.message);
        return;
      }

      setPaymentDraft((current) => (current ? { ...current, idempotencyKey: newCreditPaymentIdempotencyKey(selectedReceivable.id) } : current));
      const refreshed = await getCustomerProfileAction(profile.customer.id);
      if (refreshed.ok && refreshed.profile) {
        onProfileUpdated(refreshed.profile);
      }
      setSelectedReceivable(null);
      setPaymentDraft(null);
      toast.success(result.message);
    });
  }

  return (
    <div className="space-y-4">
      <section className="border-b border-black/10 pb-5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h2 className="font-semibold">Crédito comercial</h2>
            <p className="mt-1 text-sm text-black/55">Configuración interna y saldos por pedido.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 accent-[#e4252c]"
            />
            Crédito habilitado
          </label>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <label className="grid gap-1">
            <span className="text-xs font-semibold uppercase text-black/50">Límite de crédito</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={creditLimit}
              onChange={(event) => setCreditLimit(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-semibold uppercase text-black/50">Plazo en días</span>
            <Input
              type="number"
              min="1"
              max="365"
              step="1"
              value={termsDays}
              onChange={(event) => setTermsDays(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-semibold uppercase text-black/50">Estado</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as "active" | "suspended")}
              className="h-10 rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c]"
            >
              <option value="active">Activo</option>
              <option value="suspended">Suspendido</option>
            </select>
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={saveCredit} disabled={isPending} variant="primary">
            <Save size={16} />
            {isPending ? "Guardando..." : "Guardar crédito"}
          </Button>
        </div>
      </section>

      <section>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Crédito utilizado" value={formatCurrency(totalCreditUsed)} />
          <Metric label="Total abonado" value={formatCurrency(totalCreditPaid)} />
          <Metric label="Saldo pendiente" value={formatCurrency(pendingBalance)} />
          <Metric label="Crédito disponible" value={formatCurrency(availableCredit)} />
          <Metric label="Cuentas abiertas" value={pendingReceivables.length.toLocaleString("es-HN")} />
        </div>
        <div className="mt-4 grid gap-3 md:hidden">
          {receivablesWithOrders.length === 0 ? (
            <p className="rounded-md border border-black/10 bg-[#f4f4f5] p-4 text-sm text-black/55">Este cliente no tiene cuentas por cobrar.</p>
          ) : null}
          {receivablesWithOrders.map(({ item, order }) => {
            const canRegisterPayment = item.status !== "paid" && item.status !== "cancelled" && item.balance_due > 0;
            return (
              <article key={item.id} className="rounded-lg border border-black/10 bg-white p-4 text-sm">
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <p className="break-words font-semibold [overflow-wrap:anywhere]">Pedido {order?.order_number ?? item.order_id.slice(0, 8)}</p>
                    <p className="mt-1 text-xs text-black/50">Vencimiento: {formatHnDate(item.due_date)}</p>
                  </div>
                  <span className="w-fit rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">{creditStatusLabel[item.status] ?? "Abierto"}</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <InfoLine label="Total" value={formatCurrency(item.original_amount)} />
                  <InfoLine label="Abonado" value={formatCurrency(item.total_paid)} />
                  <InfoLine label="Saldo" value={formatCurrency(item.balance_due)} />
                </div>
                <div className="mt-3 rounded-md bg-[#f4f4f5] p-3">
                  <CreditPaymentHistory payments={item.payments} totalPaid={item.total_paid} showRecordedBy balanceDue={item.balance_due} status={item.status} />
                </div>
                <div className="mt-3">
                  {canRegisterPayment ? (
                    <Button type="button" onClick={() => openPaymentModal(item)} disabled={isPending || isSubmittingPayment} variant="ghost">
                      <PlusCircle size={16} />
                      Registrar abono
                    </Button>
                  ) : (
                    <span className="text-xs text-black/45">Sin saldo</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-4 hidden overflow-x-auto md:block">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-black/10 text-xs uppercase text-black/45">
              <tr>
                <th className="px-2 py-2">Pedido</th>
                <th className="px-2 py-2">Total</th>
                <th className="px-2 py-2">Abonado</th>
                <th className="px-2 py-2">Saldo</th>
                <th className="px-2 py-2">Vencimiento</th>
                <th className="px-2 py-2">Estado</th>
                <th className="px-2 py-2">Abonos</th>
                <th className="px-2 py-2">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {receivablesWithOrders.map(({ item, order }) => {
                return (
                  <tr key={item.id}>
                    <td className="px-2 py-2">{order?.order_number ?? item.order_id.slice(0, 8)}</td>
                    <td className="px-2 py-2">{formatCurrency(item.original_amount)}</td>
                    <td className="px-2 py-2">{formatCurrency(item.total_paid)}</td>
                    <td className="px-2 py-2 font-semibold">{formatCurrency(item.balance_due)}</td>
                    <td className="px-2 py-2">{formatHnDate(item.due_date)}</td>
                    <td className="px-2 py-2">{creditStatusLabel[item.status] ?? "Abierto"}</td>
                    <td className="px-2 py-2">
                      <CreditPaymentHistory payments={item.payments} totalPaid={item.total_paid} showRecordedBy balanceDue={item.balance_due} status={item.status} />
                    </td>
                    <td className="px-2 py-2">
                      {item.status !== "paid" && item.status !== "cancelled" && item.balance_due > 0 ? (
                        <Button type="button" onClick={() => openPaymentModal(item)} disabled={isPending || isSubmittingPayment} variant="ghost">
                          <PlusCircle size={16} />
                          Registrar abono
                        </Button>
                      ) : (
                        <span className="text-xs text-black/45">Sin saldo</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {profile.receivables.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2 py-5 text-center text-black/50">
                    Este cliente no tiene cuentas por cobrar.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {selectedReceivable && paymentDraft ? (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-black/45 px-4 py-6">
          <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-black/50">Pedido {selectedReceivable.order_number ?? selectedReceivable.order_id.slice(0, 8)}</p>
                <h2 className="mt-1 text-xl font-semibold">Registrar abono</h2>
              </div>
              <button
                type="button"
                onClick={closePaymentModal}
                disabled={isPending || isSubmittingPayment}
                className="rounded-md border border-black/10 p-2 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Total original" value={formatCurrency(selectedReceivable.original_amount)} />
              <Metric label="Total abonado" value={formatCurrency(selectedReceivable.total_paid)} />
              <Metric label="Saldo pendiente" value={formatCurrency(selectedReceivable.balance_due)} />
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold">
                Monto
                <Input
                  type="number"
                  min="0.01"
                  max={selectedReceivable.balance_due}
                  step="0.01"
                  value={paymentDraft.amount}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, amount: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                Método de pago
                <select
                  value={paymentDraft.method}
                  onChange={(event) =>
                    setPaymentDraft({
                      ...paymentDraft,
                      method: event.target.value as CommercialCreditPaymentReceivedMethod | "",
                      reference: event.target.value === "cash" ? "" : paymentDraft.reference,
                    })
                  }
                  className="h-10 rounded-md border border-black/10 bg-white px-3 text-sm font-normal outline-none focus:border-[#e4252c]"
                >
                  <option value="">Seleccionar</option>
                  <option value="bank_transfer">Transferencia bancaria</option>
                  <option value="card">Tarjeta</option>
                  <option value="cash">Efectivo</option>
                </select>
              </label>
              {paymentDraft.method !== "cash" ? (
                <label className="grid gap-1 text-sm font-semibold">
                  Referencia
                  <Input value={paymentDraft.reference} onChange={(event) => setPaymentDraft({ ...paymentDraft, reference: event.target.value })} />
                </label>
              ) : null}
              <label className="grid gap-1 text-sm font-semibold">
                Fecha de recepción
                <Input type="date" value={paymentDraft.receivedAt} onChange={(event) => setPaymentDraft({ ...paymentDraft, receivedAt: event.target.value })} />
              </label>
              <label className="grid gap-1 text-sm font-semibold sm:col-span-2">
                Comprobante opcional
                <Input
                  value={paymentDraft.receiptUrl}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, receiptUrl: event.target.value })}
                  placeholder="Enlace del comprobante"
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold sm:col-span-2">
                Nota
                <textarea
                  value={paymentDraft.note}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, note: event.target.value })}
                  rows={3}
                  className="rounded-md border border-black/10 px-3 py-2 font-normal outline-none focus:border-[#e4252c]"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" onClick={closePaymentModal} variant="ghost" disabled={isPending || isSubmittingPayment}>
                Cancelar
              </Button>
              <Button type="button" onClick={registerPayment} variant="primary" disabled={isPending || isSubmittingPayment}>
                <ReceiptText size={16} />
                {isPending || isSubmittingPayment ? "Registrando..." : "Registrar abono"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function CustomerProfileWholesale({
  profile,
  pending,
  onApproveWholesale,
  onChangeWholesaleType,
  onRejectWholesale,
  onSuspendWholesale,
  onReactivateWholesale,
}: {
  profile: CrmCustomerProfile;
  pending: boolean;
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onChangeWholesaleType: (customer: CrmCustomerOption, wholesaleCustomerType: WholesaleCustomerType) => void;
  onRejectWholesale: (customer: CrmCustomerOption) => void;
  onSuspendWholesale: (customer: CrmCustomerOption) => void;
  onReactivateWholesale: (customer: CrmCustomerOption) => void;
}) {
  const { customer, wholesaleHistory } = profile;
  const isExistingWholesale = customer.wholesale_customer_type === "existing";
  const firstPurchaseRequired = !isExistingWholesale;

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Información mayorista</h3>
          <p className="mt-1 text-sm text-black/55">
            {customer.is_wholesale ? "Cliente con acceso mayorista." : customer.has_wholesale_request ? "Solicitud mayorista pendiente." : "Cliente sin acceso mayorista."}
          </p>
        </div>
        <InfoPill>{customer.wholesale_lifecycle_status}</InfoPill>
      </div>
      <div className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InfoLine label="Estado" value={customer.wholesale_lifecycle_status} />
          <InfoLine label="Tipo de mayorista" value={isExistingWholesale ? "Mayorista existente" : "Mayorista nuevo"} />
          <InfoLine label="Primera compra mínima" value={firstPurchaseRequired ? "Requerida: L 10,000" : "No requerida"} />
          <InfoLine
            label="Primera compra mayorista"
            value={firstPurchaseRequired ? (customer.wholesale_first_purchase_completed ? "Realizada" : "Pendiente") : "No requerida"}
          />
        </div>
        <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
          {isExistingWholesale
            ? "Cliente mayorista anterior a la tienda web. Puede comprar con precio mayorista sin requisito de primera compra mínima."
            : customer.wholesale_first_purchase_completed
              ? "Cliente incorporado como mayorista nuevo. Ya completó la primera compra mayorista requerida."
              : "Cliente incorporado como mayorista nuevo. Debe completar una primera compra mayorista mínima de L 10,000."}
        </p>
        <div className="flex flex-wrap gap-2">
          {customer.wholesale_status === "pending" || customer.has_wholesale_request ? (
            <>
              <Button type="button" variant="dark" disabled={pending} onClick={() => onApproveWholesale(customer.id, "new")}>
                Aprobar como mayorista nuevo
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => onApproveWholesale(customer.id, "existing")}>
                Aprobar como mayorista existente
              </Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => onRejectWholesale(customer)}>
                Rechazar
              </Button>
            </>
          ) : null}
          {customer.wholesale_status === "approved" ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onSuspendWholesale(customer)}>
              Suspender mayorista
            </Button>
          ) : null}
          {customer.wholesale_status === "suspended" ? (
            <Button type="button" variant="dark" disabled={pending} onClick={() => onReactivateWholesale(customer)}>
              Reactivar mayorista
            </Button>
          ) : null}
          {customer.wholesale_status === "approved" || customer.wholesale_status === "suspended" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => onChangeWholesaleType(customer, isExistingWholesale ? "new" : "existing")}
            >
              Cambiar a mayorista {isExistingWholesale ? "nuevo" : "existente"}
            </Button>
          ) : null}
        </div>
        {wholesaleHistory.length === 0 ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">
            Este cliente no tiene acceso mayorista aprobado ni historial de cambios mayoristas.
          </p>
        ) : (
          wholesaleHistory.map((item) => (
            <article key={item.id} className="rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{item.note}</p>
                  <p className="text-xs text-black/50">{item.user_name ?? item.user_email ?? "Sistema"}</p>
                </div>
                <InfoPill>{formatDateTime(item.created_at)}</InfoPill>
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
  onAddNote,
  onCreateFollowup,
  onSuspend,
  onReactivate,
  onDeleteTest,
  onDeleteCustomer,
}: {
  customer: CrmCustomerOption;
  pending: boolean;
  isWholesaleRequest: boolean;
  isSuspended: boolean;
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onAddNote: (customer: CrmCustomerOption) => void;
  onCreateFollowup: (customer: CrmCustomerOption) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
  onDeleteCustomer: (customer: CrmCustomerOption) => void;
}) {
  if (customer.profile_kind === "internal") {
    return (
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <h3 className="font-semibold">Seguridad del usuario</h3>
        <p className="mt-1 text-sm text-black/55">Las compras personales se conservan, pero la identidad principal es operativa.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/admin/seguridad" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
            Abrir seguridad
          </Link>
          {isSuspended ? (
            <Button onClick={() => onReactivate(customer)} disabled={pending} variant="dark">
              <CheckCircle2 size={16} />
              Reactivar usuario
            </Button>
          ) : (
            <Button onClick={() => onSuspend(customer)} disabled={pending} variant="ghost">
              <Ban size={16} />
              Suspender usuario
            </Button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="font-semibold">Acciones del cliente</h3>
      <p className="mt-1 text-sm text-black/55">Acciones rápidas y cambios sensibles con confirmación.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} />
        <Button type="button" variant="ghost" disabled={pending} onClick={() => onAddNote(customer)}>
          <MessageSquarePlus size={16} />
          Agregar nota
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => onCreateFollowup(customer)}>
          <Clock size={16} />
          Crear seguimiento
        </Button>
        <Link href="/admin/pedidos" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver pedidos
        </Link>
        <Link href="/admin/facturas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver facturas
        </Link>
        <Link href="/admin/clientes-mayoristas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-[#f4f4f5]">
          Ver clientes mayoristas
        </Link>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-black/10 pt-4">
        {isWholesaleRequest && !customer.is_wholesale ? (
          <>
            <Button onClick={() => onApproveWholesale(customer.id, "new")} disabled={pending} variant="dark">
              Aprobar como mayorista nuevo
            </Button>
            <Button onClick={() => onApproveWholesale(customer.id, "existing")} disabled={pending} variant="secondary">
              Aprobar como mayorista existente
            </Button>
          </>
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
        ) : customer.can_delete_permanently ? (
          <Button onClick={() => onDeleteCustomer(customer)} disabled={pending} variant="secondary">
            <Trash2 size={16} />
            Eliminar permanentemente
          </Button>
        ) : (
          <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-xs text-black/55">
            {customer.delete_block_reason ?? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."}
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
  const hasRows = hasRenderableChild(children);

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-4 space-y-2">
        {hasRows ? children : <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/55">{empty}</p>}
      </div>
    </section>
  );
}

function hasRenderableChild(value: React.ReactNode): boolean {
  if (Array.isArray(value)) {
    return value.some(hasRenderableChild);
  }

  return Boolean(value);
}

function ProfileRow({ children, columns = "default" }: { children: React.ReactNode; columns?: "default" | "purchase" }) {
  return (
    <article
      className={`grid gap-3 rounded-md border border-black/10 bg-[#f4f4f5] p-3 sm:items-center ${
        columns === "purchase" ? "sm:grid-cols-[1.15fr_auto_1fr_auto_auto_auto]" : "sm:grid-cols-[1.3fr_auto_1fr_auto_auto]"
      }`}
    >
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
  onDeleteCustomer,
}: {
  customer: CrmCustomerOption | null;
  pending: boolean;
  notes: CrmNoteRow[];
  followups: CrmFollowupRow[];
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
  onDeleteCustomer: (customer: CrmCustomerOption) => void;
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
          <InfoLine label="Correo electrónico confirmado" value={customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"} />
          <InfoLine label="Pedidos" value={customer.order_count.toLocaleString("es-HN")} />
          <InfoLine label="Facturas" value={customer.invoice_count.toLocaleString("es-HN")} />
          <InfoLine label="Estado mayorista" value={customer.wholesale_lifecycle_status} />
          <InfoLine label="Total comprado" value={formatCurrency(customer.total_spent)} />
          <InfoLine label="Registro" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
          <InfoLine label="Última actividad" value={formatDateTime(customer.last_activity_at)} />
          <InfoLine label="Mayorista" value={customer.is_wholesale ? `Sí, estado ${customer.status}` : isWholesaleRequest ? "Solicitud pendiente" : "No"} />
          <InfoLine label="Ciudad" value={customer.city ?? "Sin ciudad"} />
          <InfoLine label="RTN" value={customer.tax_id ?? "Sin RTN"} />
          <InfoLine label="Valor estimado" value={formatCurrency(customer.estimated_value)} />
          <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Link href="/admin/pedidos" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver pedidos
            </Link>
            <Link href="/admin/facturas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver facturas
            </Link>
            <Link href="/admin/clientes-mayoristas" className="rounded-md border border-black/10 bg-white px-3 py-2 text-center text-xs font-semibold hover:bg-[#f4f4f5]">
              Ver mayoristas
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
                Aprobar activa precios mayoristas cuando existe una cuenta vinculada y activa.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => onApproveWholesale(customer.id, "new")} disabled={pending} variant="dark">
                  Aprobar como mayorista nuevo
                </Button>
                <Button onClick={() => onApproveWholesale(customer.id, "existing")} disabled={pending} variant="secondary">
                  Aprobar como mayorista existente
                </Button>
              </div>
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
            ) : customer.can_delete_permanently ? (
              <Button onClick={() => onDeleteCustomer(customer)} disabled={pending} variant="secondary">
                <Trash2 size={16} />
                Eliminar permanentemente
              </Button>
            ) : (
              <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-xs text-black/55">
                {customer.delete_block_reason ?? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."}
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
  onDeleteCustomer,
}: {
  customers: CrmCustomerOption[];
  pending: boolean;
  onSelect: (customerId: string) => void;
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
  onDeleteCustomer: (customer: CrmCustomerOption) => void;
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
            <p>Eliminar permanentemente solo aparece para clientes sin historial crítico. Si tiene pedidos, facturas o pagos, usa suspensión.</p>
          </div>
        </div>
      </div>
      <div className="grid gap-3 p-4 lg:hidden">
        {customers.length === 0 ? (
          <p className="rounded-md bg-[#f4f4f5] p-4 text-sm text-black/55">No hay clientes para mostrar.</p>
        ) : null}
        {customers.map((customer) => (
          <CustomerAccountCard
            key={customer.id}
            customer={customer}
            pending={pending}
            onSelect={onSelect}
            onApproveWholesale={onApproveWholesale}
            onSuspend={onSuspend}
            onReactivate={onReactivate}
            onDeleteTest={onDeleteTest}
            onDeleteCustomer={onDeleteCustomer}
          />
        ))}
      </div>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Contacto</th>
              <th className="px-4 py-3">Clasificacion</th>
              <th className="px-4 py-3">Estado de cuenta</th>
              <th className="px-4 py-3">Pedidos</th>
              <th className="px-4 py-3">Última actividad</th>
              <th className="px-4 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {customers.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-sm text-black/55" colSpan={7}>
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
                    <td className="px-4 py-3">
                      <p>{email || "Sin correo"}</p>
                      <p className="text-xs text-black/45">{customer.account_phone ?? customer.phone ?? "Sin teléfono"}</p>
                      <p className="mt-1 text-xs text-black/45">Correo electrónico: {customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {customer.primary_badges.map((badge) => (
                          <span key={badge} className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-medium text-[#b91c25]">
                            {badge}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-medium">{customer.account_state}</span>
                    </td>
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
                          <IconButton label="Aprobar como mayorista nuevo" onClick={() => onApproveWholesale(customer.id, "new")}>
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
                        ) : customer.can_delete_permanently ? (
                          <IconButton label="Eliminar permanentemente" onClick={() => onDeleteCustomer(customer)}>
                            <Trash2 size={16} />
                          </IconButton>
                        ) : (
                          <span
                            title={customer.delete_block_reason ?? "No se puede eliminar esta cuenta porque tiene historial comercial o fiscal. Puedes suspenderla."}
                            className="grid size-9 place-items-center rounded-md border border-black/10 bg-[#f4f4f5] text-black/30"
                          >
                            <Trash2 size={16} />
                          </span>
                        )}
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

function CustomerAccountCard({
  customer,
  pending,
  onSelect,
  onApproveWholesale,
  onSuspend,
  onReactivate,
  onDeleteTest,
  onDeleteCustomer,
}: {
  customer: CrmCustomerOption;
  pending: boolean;
  onSelect: (customerId: string) => void;
  onApproveWholesale: (customerId: string, wholesaleCustomerType: WholesaleCustomerType) => void;
  onSuspend: (customer: CrmCustomerOption) => void;
  onReactivate: (customer: CrmCustomerOption) => void;
  onDeleteTest: (customer: CrmCustomerOption) => void;
  onDeleteCustomer: (customer: CrmCustomerOption) => void;
}) {
  const email = customer.account_email ?? customer.email ?? "";
  const phone = customer.account_phone ?? customer.phone ?? "";
  const isWholesaleRequest = customer.has_wholesale_request && !customer.is_wholesale;
  const isSuspended = customer.account_state === "Cuenta suspendida" || customer.status === "disabled" || customer.active === false;

  return (
    <article className="rounded-lg border border-black/10 bg-white p-4 text-sm">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="break-words font-semibold [overflow-wrap:anywhere]">{customerDisplayName(customer)}</p>
          <p className="mt-1 break-words text-xs text-black/50 [overflow-wrap:anywhere]">{email || "Sin correo"}</p>
          <p className="mt-1 text-xs text-black/50">{phone || "Sin teléfono"}</p>
        </div>
        <span className="w-fit rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-semibold text-[#b91c25]">{customer.account_state}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {customer.primary_badges.length === 0 ? <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs">Sin clasificación</span> : null}
        {customer.primary_badges.slice(0, 4).map((badge) => (
          <span key={badge} className="rounded-md bg-[#fff1f2] px-2 py-1 text-xs font-medium text-[#b91c25]">
            {badge}
          </span>
        ))}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <InfoLine label="Pedidos" value={customer.order_count.toLocaleString("es-HN")} />
        <InfoLine label="Última actividad" value={formatDateTime(customer.last_activity_at)} />
        <InfoLine label="Registro" value={formatDateTime(customer.account_created_at ?? customer.created_at)} />
        <InfoLine label="Correo confirmado" value={customer.email_confirmed_at ? "Sí" : customer.user_id ? "No" : "Sin cuenta"} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onSelect(customer.id)}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5]"
        >
          <Search size={15} />
          Detalle completo
        </button>
        <Link href="/admin/pedidos" className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5]">
          <PackageSearch size={16} />
          Ver pedidos
        </Link>
        <Link href="/admin/crm" className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5]">
          <ExternalLink size={16} />
          Ver CRM
        </Link>
        {isWholesaleRequest ? (
          <button
            type="button"
            onClick={() => onApproveWholesale(customer.id, "new")}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
          >
            <CheckCircle2 size={16} />
            Aprobar mayorista
          </button>
        ) : null}
        {isSuspended ? (
          <button
            type="button"
            onClick={() => onReactivate(customer)}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
          >
            <CheckCircle2 size={16} />
            Reactivar cuenta
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSuspend(customer)}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
          >
            <Ban size={16} />
            Suspender cuenta
          </button>
        )}
        {customer.is_test_account ? (
          <button
            type="button"
            onClick={() => onDeleteTest(customer)}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
          >
            <Trash2 size={16} />
            Eliminar TEST
          </button>
        ) : customer.can_delete_permanently ? (
          <button
            type="button"
            onClick={() => onDeleteCustomer(customer)}
            disabled={pending}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f4f4f5] disabled:opacity-50"
          >
            <Trash2 size={16} />
            Eliminar
          </button>
        ) : (
          <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-xs text-black/55">
            {customer.delete_block_reason ?? "No se puede eliminar; usa suspensión."}
          </p>
        )}
      </div>
      {pending ? <p className="mt-2 text-xs text-black/45">Procesando...</p> : null}
    </article>
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

function CrmPurposePanel() {
  const terms = [
    {
      title: "Prospecto",
      text: "Persona o negocio interesado que aún no ha comprado.",
      icon: <Target size={17} />,
    },
    {
      title: "Cliente",
      text: "Persona que ya compró, tiene cuenta o mantiene relación comercial.",
      icon: <Users size={17} />,
    },
    {
      title: "Seguimiento",
      text: "Tarea pendiente para llamar, escribir por WhatsApp o atender una solicitud.",
      icon: <ListChecks size={17} />,
    },
    {
      title: "Nota",
      text: "Registro de llamadas, acuerdos, dudas, preferencias o historial importante.",
      icon: <NotebookPen size={17} />,
    },
    {
      title: "Solicitud mayorista",
      text: "Cliente que solicita precios especiales o acceso de mayoreo.",
      icon: <UserPlus size={17} />,
    },
    {
      title: "Pipeline estimado",
      text: "Valor aproximado de oportunidades comerciales abiertas.",
      icon: <BadgeDollarSign size={17} />,
    },
  ];

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="max-w-3xl">
            <h2 className="text-base font-semibold">CRM de Car Zone Accesorios</h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              El CRM sirve para dar seguimiento a clientes, prospectos y solicitudes comerciales. Aquí se registran llamadas,
              notas, tareas pendientes, recordatorios, solicitudes mayoristas y oportunidades de venta.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-black/10 bg-[#f4f4f5] px-3 py-1 text-xs font-medium text-black/60">
            <Clock size={14} />
            Seguimiento comercial
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {terms.map((term) => (
            <HelpCard key={term.title} title={term.title} text={term.text} icon={term.icon} />
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">¿Cómo usar el CRM?</h2>
        <ol className="mt-3 space-y-3 text-sm leading-5 text-black/65">
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#111827] text-xs font-semibold text-white">1</span>
            <span>Registra prospectos cuando alguien pregunte por productos.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#111827] text-xs font-semibold text-white">2</span>
            <span>Agrega notas después de llamadas o mensajes de WhatsApp.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#111827] text-xs font-semibold text-white">3</span>
            <span>Crea seguimientos para recordar contactar al cliente.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#111827] text-xs font-semibold text-white">4</span>
            <span>Marca como completado cuando ya se atendió.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#111827] text-xs font-semibold text-white">5</span>
            <span>Usa prioridad alta para clientes importantes o ventas urgentes.</span>
          </li>
        </ol>
      </div>
    </section>
  );
}

function FollowupHistoryList({
  followups,
  customers,
  pending,
  onComplete,
  onArchive,
  onEdit,
  onAddNote,
  onOpenDetail,
}: {
  followups: CrmFollowupRow[];
  customers: CrmCustomerOption[];
  pending: boolean;
  onComplete: (id: string) => void;
  onArchive: (id: string) => void;
  onEdit: (followup: CrmFollowupRow) => void;
  onAddNote: (customerId: string) => void;
  onOpenDetail: (followup: CrmFollowupRow) => void;
}) {
  const customersById = new Map(customers.map((customer) => [customer.id, customer]));

  if (followups.length === 0) {
    return (
      <div className="p-5">
        <div className="rounded-lg border border-dashed border-black/15 bg-[#f8fafc] px-4 py-8 text-center text-sm text-black/55">
          No se encontraron resultados con estos filtros.
        </div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-black/10">
      {followups.map((item) => (
        <FollowupHistoryCard
          key={item.id}
          followup={item}
          customer={customersById.get(item.customer_id)}
          pending={pending}
          onComplete={onComplete}
          onArchive={onArchive}
          onEdit={onEdit}
          onAddNote={onAddNote}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  );
}

function FollowupHistoryCard({
  followup,
  customer,
  pending,
  onComplete,
  onArchive,
  onEdit,
  onAddNote,
  onOpenDetail,
}: {
  followup: CrmFollowupRow;
  customer?: CrmCustomerOption;
  pending: boolean;
  onComplete: (id: string) => void;
  onArchive: (id: string) => void;
  onEdit: (followup: CrmFollowupRow) => void;
  onAddNote: (customerId: string) => void;
  onOpenDetail: (followup: CrmFollowupRow) => void;
}) {
  const name = followupDisplayName(followup);
  const email = cleanText(customer?.email ?? customer?.account_email, "Sin correo registrado");
  const phone = cleanText(followup.phone ?? customer?.phone ?? customer?.account_phone, "Sin teléfono registrado");
  const lastActivity = formatDateTime(customer?.last_activity_at ?? followup.created_at);
  const note = cleanText(followup.notes, "Sin notas recientes");
  const nextAction = cleanText(followup.next_action, "Sin próxima acción");
  const valueLabel = followup.estimated_value > 0 ? formatCurrency(followup.estimated_value) : "Sin valor estimado";
  const isCompleted = followup.status === "completed";
  const isArchived = followup.status === "cancelled";

  return (
    <article className="grid gap-4 p-4 text-sm xl:grid-cols-[minmax(210px,0.9fr)_minmax(300px,1.4fr)_minmax(220px,0.8fr)_auto] xl:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-black/10 bg-[#f4f4f5] px-2 py-1 text-xs font-medium text-black/60">
            {followup.customer_profile_kind === "internal" ? "Usuario interno" : followup.customer_profile_label}
          </span>
          {customer?.is_test_account ? (
            <span className="rounded-full border border-[#fed7aa] bg-[#fff7ed] px-2 py-1 text-xs font-medium text-[#9a3412]">
              Dato de prueba
            </span>
          ) : null}
        </div>
        <h3 className="mt-2 break-words text-base font-semibold">{name}</h3>
        <p className="mt-1 break-words text-xs text-black/45">{followupSecondaryName(followup)}</p>
        <div className="mt-3 space-y-2 text-xs text-black/60">
          <div className="flex min-w-0 items-center gap-2">
            <PhoneCall size={14} className="shrink-0 text-black/40" />
            <span className="min-w-0 break-words">{phone}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Mail size={14} className="shrink-0 text-black/40" />
            <span className="min-w-0 break-words">{email}</span>
          </div>
        </div>
        <ContactActions phone={followup.phone ?? customer?.phone ?? customer?.account_phone} customerName={name} className="mt-3" />
      </div>

      <div className="min-w-0 space-y-3">
        <div>
          <p className="text-xs font-medium uppercase text-black/45">{interactionLabels[followup.interaction_type]}</p>
          <h4 className="mt-1 break-words font-semibold">{followup.title}</h4>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <InfoTile icon={<ListChecks size={15} />} label="Próxima acción" value={nextAction} />
          <InfoTile icon={<CalendarClock size={15} />} label="Fecha programada" value={formatDateTime(followup.due_at)} urgent={isOverdue(followup)} />
          <InfoTile icon={<NotebookPen size={15} />} label="Nota breve" value={note} />
          <InfoTile icon={<Clock size={15} />} label="Última actividad" value={lastActivity} />
        </div>
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-2">
          <span className={`rounded-full border px-2 py-1 text-xs font-medium ${priorityClasses(followup.priority)}`}>
            Prioridad {priorityLabels[followup.priority]}
          </span>
          <span className={`rounded-full border px-2 py-1 text-xs font-medium ${followupStatusClasses(followup)}`}>
            {followupStatusLabel(followup)}
          </span>
        </div>
        <InfoTile icon={<BadgeDollarSign size={15} />} label="Pipeline estimado" value={valueLabel} />
      </div>

      <div className="flex flex-wrap gap-2 xl:w-40 xl:justify-end">
        {!isCompleted && !isArchived ? (
          <IconButton label="Completar seguimiento" onClick={() => onComplete(followup.id)} disabled={pending}>
            <CheckCircle2 size={16} />
          </IconButton>
        ) : null}
        <IconButton label="Agregar nota" onClick={() => onAddNote(followup.customer_id)} disabled={pending}>
          <MessageSquarePlus size={16} />
        </IconButton>
        <IconButton label="Editar seguimiento" onClick={() => onEdit(followup)} disabled={pending}>
          <Pencil size={16} />
        </IconButton>
        <IconButton label="Ver detalle" onClick={() => onOpenDetail(followup)}>
          <Eye size={16} />
        </IconButton>
        {!isArchived ? (
          <IconButton label="Archivar seguimiento" onClick={() => onArchive(followup.id)} disabled={pending}>
            <Archive size={16} />
          </IconButton>
        ) : null}
      </div>
    </article>
  );
}

function InfoTile({
  icon,
  label,
  value,
  urgent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  urgent?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-md border px-3 py-2 ${urgent ? "border-[#fed7aa] bg-[#fff7ed]" : "border-black/10 bg-[#f8fafc]"}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-black/45">
        {icon}
        <span>{label}</span>
      </div>
      <p className={`mt-1 break-words text-sm ${urgent ? "font-semibold text-[#9a3412]" : "text-black/70"}`}>{value}</p>
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

function HelpCard({ title, text, icon }: { title: string; text: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-3 text-sm">
      <div className="flex items-center gap-2">
        {icon ? <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#f4f4f5] text-black/60">{icon}</span> : null}
        <p className="font-semibold">{title}</p>
      </div>
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
      {customers.filter((customer) => customer.profile_kind === "customer").map((customer) => (
        <option key={customer.id} value={customer.id}>
          {customerDisplayName(customer)} - {customer.phone}
        </option>
      ))}
    </select>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f4f4f5] disabled:cursor-not-allowed disabled:opacity-50"
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



