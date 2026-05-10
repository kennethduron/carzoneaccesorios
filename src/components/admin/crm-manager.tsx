"use client";

import { useMemo, useState, useTransition } from "react";
import {
  CheckCircle2,
  Clock,
  MessageSquarePlus,
  PhoneCall,
  Save,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import {
  saveCrmFollowupAction,
  saveCrmLeadAction,
  saveCrmNoteAction,
  setCrmFollowupStatusAction,
} from "@/app/admin/crm/actions";
import { ContactActions } from "@/components/contact-actions";
import { Button, Input } from "@/components/ui";
import type {
  AdminCrmData,
  CrmCustomerOption,
  CrmFollowupInput,
  CrmFollowupRow,
  CrmInteractionType,
  CrmLeadInput,
  CrmLeadStatus,
  CrmNoteInput,
  CrmPriority,
} from "@/types/crm";
import { formatCurrency } from "@/utils/pricing";

type CrmManagerProps = {
  data: AdminCrmData;
};

const interactionLabels: Record<CrmInteractionType, string> = {
  seguimiento: "Seguimiento",
  llamada: "Llamada",
  nota: "Nota",
  reunion: "Reunion",
  prospecto: "Prospecto",
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
  return value ? new Date(value).toLocaleString("es-HN") : "Sin fecha";
}

function isOverdue(followup: CrmFollowupRow) {
  return followup.status === "pending" && followup.due_at ? new Date(followup.due_at) < new Date() : false;
}

export function CrmManager({ data }: CrmManagerProps) {
  const [query, setQuery] = useState("");
  const [lead, setLead] = useState<CrmLeadInput>(emptyLead);
  const [followup, setFollowup] = useState<CrmFollowupInput>(emptyFollowup);
  const [note, setNote] = useState<CrmNoteInput>(emptyNote);
  const [selectedCustomerId, setSelectedCustomerId] = useState(data.customers[0]?.id ?? "");
  const [selectedFollowupId, setSelectedFollowupId] = useState(data.followups[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const filteredFollowups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.followups.filter((item) => {
      if (!normalized) {
        return true;
      }

      return `${item.title} ${item.next_action ?? ""} ${item.notes ?? ""} ${item.customer_name ?? ""} ${item.business_name ?? ""}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [data.followups, query]);

  const pendingFollowups = data.followups.filter((item) => item.status === "pending");
  const overdueCount = data.followups.filter(isOverdue).length;
  const prospects = data.customers.filter((customer) => customer.lead_status !== "cliente");
  const estimatedPipeline = prospects.reduce((sum, customer) => sum + customer.estimated_value, 0);
  const monthlyPipeline = prospects.reduce((sum, customer) => sum + customer.monthly_amount, 0);
  const selectedCustomer = data.customers.find((customer) => customer.id === selectedCustomerId) ?? data.customers[0] ?? null;
  const selectedFollowup =
    data.followups.find((item) => item.id === selectedFollowupId) ?? filteredFollowups[0] ?? data.followups[0] ?? null;

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

  function submitLead() {
    startTransition(async () => {
      const result = await saveCrmLeadAction(lead);
      setMessage(result.message);
      if (result.ok) {
        setLead(emptyLead);
      }
    });
  }

  function submitFollowup() {
    startTransition(async () => {
      const result = await saveCrmFollowupAction(followup);
      setMessage(result.message);
      if (result.ok) {
        setFollowup(emptyFollowup);
      }
    });
  }

  function submitNote() {
    startTransition(async () => {
      const result = await saveCrmNoteAction(note);
      setMessage(result.message);
      if (result.ok) {
        setNote(emptyNote);
      }
    });
  }

  function setStatus(id: string, status: "completed" | "cancelled") {
    startTransition(async () => {
      const result = await setCrmFollowupStatusAction(id, status);
      setMessage(result.message);
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Prospectos" value={prospects.length.toLocaleString("es-HN")} />
        <Metric label="Pendientes" value={pendingFollowups.length.toLocaleString("es-HN")} />
        <Metric label="Atrasados" value={overdueCount.toLocaleString("es-HN")} />
        <Metric label="Pipeline mensual" value={formatCurrency(monthlyPipeline)} />
      </div>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar cliente, acción o nota"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <p className="text-sm text-black/55">
            Pipeline estimado: <span className="font-semibold text-[#1c1d1b]">{formatCurrency(estimatedPipeline)}</span>
          </p>
        </div>
        {message ? <p className="mt-3 text-sm text-black/60">{message}</p> : null}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <UserPlus size={19} />
            <h2 className="font-semibold">Cliente potencial</h2>
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

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <PhoneCall size={19} />
            <h2 className="font-semibold">Seguimiento</h2>
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

      <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <div className="overflow-hidden rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-5">
            <h2 className="font-semibold">Historial CRM</h2>
            <p className="mt-1 text-sm text-black/55">Seguimientos, llamadas, notas y reuniones.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
                <tr>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">Actividad</th>
                  <th className="px-4 py-3">Próxima acción</th>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Prioridad</th>
                  <th className="px-4 py-3">Valor</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acciónes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {filteredFollowups.map((item) => (
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
                      <span className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs">{priorityLabels[item.priority]}</span>
                    </td>
                    <td className="px-4 py-3">
                      <p>{formatCurrency(item.estimated_value)}</p>
                      <p className="text-xs text-black/45">Mensual {formatCurrency(item.monthly_amount)}</p>
                    </td>
                    <td className="px-4 py-3">{item.status}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <IconButton label="Completar" onClick={() => setStatus(item.id, "completed")}>
                          <CheckCircle2 size={16} />
                        </IconButton>
                        <IconButton label="Cancelar" onClick={() => setStatus(item.id, "cancelled")}>
                          <X size={16} />
                        </IconButton>
                        <IconButton label="Ver detalle" onClick={() => setSelectedFollowupId(item.id)}>
                          <Search size={16} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-5">
          <CustomerDetailCard customer={selectedCustomer} />
          <FollowupDetailCard followup={selectedFollowup} />

          <div className="rounded-lg border border-black/10 bg-white p-5">
            <h2 className="font-semibold">Clientes CRM</h2>
            <div className="mt-4 space-y-3">
              {data.customers.length === 0 ? (
                <p className="text-sm text-black/55">No hay clientes registrados.</p>
              ) : (
                data.customers.slice(0, 8).map((customer) => (
                  <article
                    key={customer.id}
                    className={`rounded-md p-3 text-sm transition-colors ${
                      selectedCustomer?.id === customer.id ? "bg-[#e8f3f2]" : "bg-[#f7f7f2]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">{customerDisplayName(customer)}</p>
                        <p className="mt-1 text-xs text-black/45">{customer.phone || "Sin telefono"}</p>
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

          <div className="rounded-lg border border-black/10 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <MessageSquarePlus size={19} />
              <h2 className="font-semibold">Nota rapida</h2>
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
                  <article key={item.id} className="rounded-md bg-[#f7f7f2] p-3 text-sm">
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
  );
}

function CustomerDetailCard({ customer }: { customer: CrmCustomerOption | null }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-5">
      <h2 className="font-semibold">Detalle del cliente</h2>
      {customer ? (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="font-semibold">{customerDisplayName(customer)}</p>
            <p className="text-xs text-black/45">{customer.email ?? "Sin correo registrado"}</p>
          </div>
          <InfoLine label="Teléfono" value={customer.phone || "Sin teléfono"} />
          <InfoLine label="Estado" value={leadStatusLabels[customer.lead_status]} />
          <InfoLine label="Valor estimado" value={formatCurrency(customer.estimated_value)} />
          <InfoLine label="Mensualidad" value={formatCurrency(customer.monthly_amount)} />
          <ContactActions phone={customer.phone} customerName={customerDisplayName(customer)} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-black/55">No hay cliente seleccionado.</p>
      )}
    </div>
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
          <ContactActions phone={followup.phone} customerName={followup.business_name ?? followup.customer_name} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-black/55">No hay seguimiento seleccionado.</p>
      )}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md bg-[#f7f7f2] px-3 py-2">
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
      className="grid size-9 place-items-center rounded-md border border-black/10 bg-white transition-colors hover:bg-[#f7f7f2]"
    >
      {children}
    </button>
  );
}
