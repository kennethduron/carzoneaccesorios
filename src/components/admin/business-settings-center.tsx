"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Save, ShieldCheck } from "lucide-react";
import { saveBusinessSettingsAction } from "@/app/admin/configuracion/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AppRole } from "@/types/auth";
import type { BusinessSettings, DashboardCardKey } from "@/types/settings";

type BusinessSettingsCenterProps = {
  settings: BusinessSettings;
  currentRole: AppRole;
};

type TabId = "notifications" | "crm" | "wholesale" | "orders" | "inventory" | "dashboard" | "contact" | "technical";

const dashboardCards: Array<[DashboardCardKey, string, string]> = [
  ["sales_today", "Ventas del día", "Total vendido según facturas emitidas."],
  ["pending_orders", "Pedidos pendientes", "Pedidos nuevos o recibidos."],
  ["pending_payments", "Pagos pendientes", "Transferencias y pagos por revisar."],
  ["low_inventory", "Inventario bajo", "Productos sin stock o bajo mínimo."],
  ["wholesale_requests", "Solicitudes mayoristas", "Cuentas mayoristas por revisar."],
  ["customers_attention", "Clientes por atender", "Seguimientos CRM vencidos o para hoy."],
  ["pending_invoices", "Facturas pendientes", "Documentos pendientes de emisión."],
  ["bac_alerts", "Alertas BAC", "Preparación bancaria y pendientes de pasarela."],
  ["backup_cron_status", "Backups/cron", "Estado técnico visible solo para perfiles técnicos."],
];

export function BusinessSettingsCenter({ settings, currentRole }: BusinessSettingsCenterProps) {
  const [form, setForm] = useState(settings);
  const [activeTab, setActiveTab] = useState<TabId>("notifications");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const canSeeTechnical = currentRole === "technical_owner";
  const visibleDashboardCards = canSeeTechnical ? dashboardCards : dashboardCards.filter(([key]) => key !== "backup_cron_status");
  const tabs = useMemo(
    () =>
      [
        ["notifications", "Notificaciones"],
        ["crm", "CRM"],
        ["wholesale", "Mayoristas"],
        ["orders", "Pedidos"],
        ["inventory", "Inventario"],
        ["dashboard", "Dashboard"],
        ["contact", "Contacto"],
        ...(canSeeTechnical ? [["technical", "Técnico"] as const] : []),
      ] as Array<readonly [TabId, string]>,
    [canSeeTechnical],
  );

  function update<K extends keyof BusinessSettings>(field: K, value: BusinessSettings[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateDashboardCard(key: DashboardCardKey, value: boolean) {
    setForm((current) => ({
      ...current,
      dashboard_cards: {
        ...current.dashboard_cards,
        [key]: value,
      },
    }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveBusinessSettingsAction(form);
      setMessage(result.message);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/50">Centro de Configuración Empresarial</p>
        <h1 className="mt-1 text-2xl font-semibold">Reglas operativas del negocio</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">
          Controla ajustes cotidianos sin tocar secretos, API keys ni configuración técnica sensible.
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto rounded-lg border border-black/10 bg-white p-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
              activeTab === id ? "bg-[#e4252c] text-white" : "text-black/60 hover:bg-[#f4f4f5]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "notifications" ? (
        <SettingsPanel title="Notificaciones" description="Correos internos para eventos importantes del negocio.">
          <Field label="Correos destinatarios" help="Separa múltiples correos con coma. No uses aquí API keys ni credenciales.">
            <Input
              value={form.notification_emails}
              onChange={(event) => update("notification_emails", event.target.value)}
              placeholder="dueno@carzone.com, ventas@carzone.com"
            />
          </Field>
          <SwitchGrid>
            <Switch label="Pedido nuevo" checked={form.notify_new_orders} onChange={(value) => update("notify_new_orders", value)} />
            <Switch
              label="Comprobante de transferencia"
              checked={form.notify_transfer_receipt_uploaded}
              onChange={(value) => update("notify_transfer_receipt_uploaded", value)}
            />
            <Switch
              label="Solicitud mayorista"
              checked={form.notify_wholesale_requests}
              onChange={(value) => update("notify_wholesale_requests", value)}
            />
            <Switch
              label="Cliente crea cuenta"
              checked={form.notify_customer_account_created}
              onChange={(value) => update("notify_customer_account_created", value)}
            />
            <Switch label="Producto bajo stock" checked={form.notify_low_stock} onChange={(value) => update("notify_low_stock", value)} />
            <Switch
              label="Resumen diario"
              checked={form.send_daily_activity_summary}
              onChange={(value) => update("send_daily_activity_summary", value)}
            />
            <Switch
              label="Resumen semanal"
              checked={form.send_weekly_sales_summary}
              onChange={(value) => update("send_weekly_sales_summary", value)}
            />
          </SwitchGrid>
        </SettingsPanel>
      ) : null}

      {activeTab === "crm" ? (
        <SettingsPanel title="CRM" description="Reglas para seguimiento comercial, clientes inactivos y detección de duplicados.">
          <SwitchGrid>
            <Switch
              label="Seguimiento al registrar cliente"
              checked={form.crm_auto_followup_on_customer_created}
              onChange={(value) => update("crm_auto_followup_on_customer_created", value)}
            />
            <Switch
              label="Seguimiento después de compra"
              checked={form.crm_auto_followup_after_purchase}
              onChange={(value) => update("crm_auto_followup_after_purchase", value)}
            />
            <Switch
              label="Mostrar clientes inactivos"
              checked={form.crm_show_inactive_customers}
              onChange={(value) => update("crm_show_inactive_customers", value)}
            />
            <Switch
              label="Detectar posibles duplicados"
              checked={form.crm_detect_duplicates}
              onChange={(value) => update("crm_detect_duplicates", value)}
            />
            <Switch
              label="Alertar seguimientos vencidos"
              checked={form.crm_alert_overdue_followups}
              onChange={(value) => update("crm_alert_overdue_followups", value)}
            />
          </SwitchGrid>
        </SettingsPanel>
      ) : null}

      {activeTab === "wholesale" ? (
        <SettingsPanel title="Mayoristas" description="Controla compras mayoristas y reglas de primera compra.">
          <SwitchGrid>
            <Switch
              label="Aprobación manual"
              checked={form.wholesale_manual_approval}
              onChange={(value) => update("wholesale_manual_approval", value)}
            />
            <Switch
              label="Compras mayoristas activas"
              checked={form.wholesale_purchases_enabled}
              onChange={(value) => update("wholesale_purchases_enabled", value)}
            />
            <Switch
              label="Compras posteriores sin mínimo"
              checked={form.wholesale_allow_repeat_without_minimum}
              onChange={(value) => update("wholesale_allow_repeat_without_minimum", value)}
            />
            <Switch
              label="Suspender si cuenta está inactiva"
              checked={form.wholesale_auto_suspend_inactive}
              onChange={(value) => update("wholesale_auto_suspend_inactive", value)}
            />
          </SwitchGrid>
          <Field label="Monto mínimo primera compra mayorista">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.first_wholesale_minimum}
              onChange={(event) => update("first_wholesale_minimum", Number(event.target.value))}
            />
          </Field>
        </SettingsPanel>
      ) : null}

      {activeTab === "orders" ? (
        <SettingsPanel title="Pedidos" description="Métodos de pago, mensajes al cliente y reglas de transferencia.">
          <SwitchGrid>
            <Switch label="Permitir transferencia" checked={form.allow_bank_transfer} onChange={(value) => update("allow_bank_transfer", value)} />
            <Switch
              label="Permitir pago contra entrega"
              checked={form.allow_cash_on_delivery}
              onChange={(value) => update("allow_cash_on_delivery", value)}
            />
            <Switch
              label="Enviar confirmación de pedido"
              checked={form.send_order_confirmation_email}
              onChange={(value) => update("send_order_confirmation_email", value)}
            />
            <Switch
              label="Notificar cambios de estado"
              checked={form.send_order_status_update_email}
              onChange={(value) => update("send_order_status_update_email", value)}
            />
            <Switch
              label="Referencia bancaria obligatoria"
              help="Siempre obligatoria para transferencias nuevas."
              checked
              onChange={() => update("require_bank_reference", true)}
            />
            <Switch
              label="Comisión pago al recibir"
              checked={form.enable_cash_on_delivery_fee}
              onChange={(value) => update("enable_cash_on_delivery_fee", value)}
            />
          </SwitchGrid>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Tarjeta BAC">
              <select
                value={form.bac_card_status}
                onChange={(event) => update("bac_card_status", event.target.value as BusinessSettings["bac_card_status"])}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="hidden">Oculta</option>
                <option value="pending">Visible como pendiente</option>
                <option value="active">Activa</option>
              </select>
            </Field>
            <Field label="Comprobante de transferencia">
              <select
                value="optional"
                onChange={() => update("transfer_receipt_requirement", "optional")}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="optional">Opcional</option>
              </select>
              <p className="mt-1 text-xs text-black/50">El comprobante ya no puede ser obligatorio; la referencia bancaria valida el pedido.</p>
            </Field>
          </div>
        </SettingsPanel>
      ) : null}

      {activeTab === "inventory" ? (
        <SettingsPanel title="Inventario" description="Alertas, catálogo y reservas temporales de stock.">
          <SwitchGrid>
            <Switch
              label="Alertas de bajo stock"
              checked={form.low_stock_alerts_enabled}
              onChange={(value) => update("low_stock_alerts_enabled", value)}
            />
            <Switch
              label="Reservas temporales"
              checked={form.stock_reservations_enabled}
              onChange={(value) => update("stock_reservations_enabled", value)}
            />
          </SwitchGrid>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Umbral global bajo stock">
              <Input
                type="number"
                min={0}
                value={form.global_low_stock_threshold}
                onChange={(event) => update("global_low_stock_threshold", Number(event.target.value))}
              />
            </Field>
            <Field label="Productos agotados">
              <select
                value={form.out_of_stock_catalog_mode}
                onChange={(event) =>
                  update("out_of_stock_catalog_mode", event.target.value as BusinessSettings["out_of_stock_catalog_mode"])
                }
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                <option value="show">Mostrar en catálogo</option>
                <option value="hide">Ocultar del catálogo</option>
              </select>
            </Field>
            <Field label="Expiración de reserva (minutos)">
              <Input
                type="number"
                min={15}
                max={10080}
                value={form.stock_reservation_minutes}
                onChange={(event) => update("stock_reservation_minutes", Number(event.target.value))}
              />
            </Field>
          </div>
        </SettingsPanel>
      ) : null}

      {activeTab === "dashboard" ? (
        <SettingsPanel title="Dashboard" description="Elige qué tarjetas operativas ve el dueño al entrar al panel.">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleDashboardCards.map(([key, label, help]) => (
              <Switch
                key={key}
                label={label}
                help={help}
                checked={form.dashboard_cards[key]}
                onChange={(value) => updateDashboardCard(key, value)}
              />
            ))}
          </div>
        </SettingsPanel>
      ) : null}

      {activeTab === "contact" ? (
        <SettingsPanel title="Redes y contacto" description="Datos públicos que aparecen en tienda, contacto y políticas.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Facebook">
              <Input value={form.facebook_url} onChange={(event) => update("facebook_url", event.target.value)} placeholder="https://..." />
            </Field>
            <Field label="Instagram">
              <Input value={form.instagram_url} onChange={(event) => update("instagram_url", event.target.value)} placeholder="https://..." />
            </Field>
            <Field label="WhatsApp">
              <Input value={form.whatsapp_url} onChange={(event) => update("whatsapp_url", event.target.value)} placeholder="https://wa.me/504..." />
            </Field>
            <Field label="TikTok">
              <Input value={form.tiktok_url} onChange={(event) => update("tiktok_url", event.target.value)} placeholder="https://..." />
            </Field>
            <Field label="Teléfono">
              <Input value={form.customer_service_phone} onChange={(event) => update("customer_service_phone", event.target.value)} />
            </Field>
            <Field label="Correo">
              <Input type="email" value={form.customer_service_email} onChange={(event) => update("customer_service_email", event.target.value)} />
            </Field>
            <Field label="Dirección">
              <Input value={form.business_address} onChange={(event) => update("business_address", event.target.value)} />
            </Field>
            <Field label="Horario">
              <Input value={form.customer_service_hours} onChange={(event) => update("customer_service_hours", event.target.value)} />
            </Field>
            <Field label="WhatsApp servicio al cliente">
              <Input
                value={form.customer_service_whatsapp}
                onChange={(event) => update("customer_service_whatsapp", event.target.value)}
                placeholder="https://wa.me/504..."
              />
            </Field>
          </div>
        </SettingsPanel>
      ) : null}

      {activeTab === "technical" && canSeeTechnical ? (
        <SettingsPanel title="Técnico" description="Accesos técnicos seguros. No se muestran secretos ni API keys en esta pantalla.">
          <div className="grid gap-3 md:grid-cols-3">
            <TechnicalLink href="/admin/uso" title="Uso y monitoreo" text="Volumen de datos, logs antiguos y referencias técnicas." />
            <TechnicalLink href="/admin/seguridad" title="Seguridad" text="Auditoría, usuarios, roles y controles administrativos." />
            <TechnicalLink href="/admin/revision-bac" title="BAC" text="Checklist técnico/comercial de pasarela sin credenciales visibles." />
          </div>
          <div className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
            Las variables de Vercel, Supabase, Cloudinary, Resend, Brevo y cron no se exponen ni se editan desde
            esta UI.
          </div>
        </SettingsPanel>
      ) : null}

      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-lg border border-black/10 bg-white/95 p-4 shadow-lg backdrop-blur">
        <Button onClick={save} disabled={isPending} variant="dark">
          <Save size={17} />
          {isPending ? "Guardando..." : "Guardar cambios"}
        </Button>
        {message ? <p className="text-sm text-black/60">{message}</p> : null}
        <p className="inline-flex items-center gap-2 text-sm text-black/50">
          <ShieldCheck size={16} />
          Todo cambio queda registrado en auditoría.
        </p>
      </div>
    </section>
  );
}

function SettingsPanel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-5 rounded-lg border border-black/10 bg-white p-5">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-black/55">{description}</p>
      </div>
      {children}
    </section>
  );
}

function SwitchGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Switch({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-lg border border-black/10 bg-[#f8f8f8] p-4">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 accent-[#e4252c]"
      />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {help ? <span className="mt-1 block text-xs leading-5 text-black/55">{help}</span> : null}
      </span>
    </label>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-black/50">{help}</span> : null}
    </label>
  );
}

function TechnicalLink({ href, title, text }: { href: string; title: string; text: string }) {
  return (
    <Link href={href} className="rounded-lg border border-black/10 bg-[#f8f8f8] p-4 transition-colors hover:border-[#e4252c]">
      <p className="font-semibold">{title}</p>
      <p className="mt-2 text-sm text-black/55">{text}</p>
    </Link>
  );
}
