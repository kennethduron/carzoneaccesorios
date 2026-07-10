import Link from "next/link";
import { FileText, PackageCheck, Route, ShoppingBag, UserRound } from "lucide-react";
import { CreditPaymentHistory } from "@/components/admin/credit-payment-history";
import { LogoutButton } from "@/components/auth";
import { PublicInvoiceDownloadButton } from "@/components/store/public-invoice-download-button";
import { CustomerCreditNotificationToast } from "@/components/store/customer-credit-notification-toast";
import { WholesaleAccountRequestCard } from "@/components/store/wholesale-account-request-card";
import { WholesaleRequirementSummary } from "@/components/store/wholesale-program-info";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { requireSession } from "@/lib/auth/session";
import {
  getCustomerAccountSummary,
  getCustomerIssuedInvoices,
  getCustomerOrders,
  type CustomerOrderRow,
} from "@/services/supabase/customer-account.service";
import { getActiveCreditAccountForUser, getCustomerReceivablesForUser, getUnreadCustomerCreditNotifications } from "@/services/supabase/credit.service";
import type { StoreInvoice } from "@/types/invoices";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

export const dynamic = "force-dynamic";

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "En preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Recibido",
  confirmed: "Confirmado",
  paid: "Pago confirmado",
  preparing: "En preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  approved: "Confirmado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
};

const creditStatusLabels: Record<string, string> = {
  open: "Abierto",
  partial: "Pago parcial",
  paid: "Pagado",
  overdue: "Vencido",
  cancelled: "Cancelado",
};

const wholesaleStatusLabels: Record<string, string> = {
  regular: "No solicitado",
  pending: "En revisión",
  approved: "Aprobado",
  rejected: "Rechazado",
  suspended: "Suspendido",
  guest: "No solicitado",
};

function formatDate(value: string | null) {
  if (!value) {
    return "No disponible";
  }

  return formatHnDate(value);
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "No disponible";
  }

  return formatHnDateTime(value);
}

function invoiceIsIssued(invoice: StoreInvoice) {
  return ["emitida", "issued", "paid"].includes(invoice.status);
}

function orderHasIssuedInvoice(order: CustomerOrderRow) {
  return order.invoices.some((invoice) => ["emitida", "issued", "paid"].includes(invoice.status));
}

function pendingInvoiceMessage(order: CustomerOrderRow) {
  if (orderHasIssuedInvoice(order)) {
    return null;
  }

  if (order.payment_method === "bank_transfer") {
    return order.payment_status === "approved"
      ? "Tu factura estará disponible cuando el equipo la emita."
      : "Factura pendiente. Estará disponible cuando el equipo confirme tu pago.";
  }

  if (order.payment_method === "cash") {
    return "Factura pendiente. Estará disponible cuando el pago o entrega sea confirmado.";
  }

  if (order.payment_method === "commercial_credit") {
    return "Factura pendiente. Estará disponible cuando el equipo la emita.";
  }

  return order.payment_status === "approved"
    ? "Tu factura estará disponible cuando sea emitida."
    : "Estamos revisando tu pago.";
}

export default async function CuentaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requireSession();
  const [wholesaleState, accountSummary, recentOrders, issuedInvoices, creditAccount, creditReceivables, creditNotifications] = await Promise.all([
    getWholesaleAccessStateAction(),
    getCustomerAccountSummary(profile.id),
    getCustomerOrders(profile.id, 5),
    getCustomerIssuedInvoices(profile.id, 5),
    getActiveCreditAccountForUser(profile.id).catch(() => null),
    getCustomerReceivablesForUser(profile.id, 10).catch(() => []),
    getUnreadCustomerCreditNotifications(profile.id).catch(() => []),
  ]);
  const params = (await searchParams) ?? {};
  const confirmed = params.confirmed === "1";
  const visibleRole = wholesaleState.kind === "approved" ? "Mayorista" : "Cliente";
  const firstPurchaseRequirement = wholesaleState.firstPurchaseRequirement;
  const wholesaleLifecycleStatus =
    wholesaleState.kind === "approved"
      ? wholesaleState.customerType === "existing" || firstPurchaseRequirement?.completed
        ? "Mayorista activo"
        : "Pendiente de primera compra"
      : wholesaleStatusLabels[wholesaleState.kind] ?? "No solicitado";
  const pendingInvoiceOrders = recentOrders.filter((order) => !orderHasIssuedInvoice(order)).slice(0, 3);
  const openReceivables = creditReceivables.filter((item) => item.status !== "paid" && item.status !== "cancelled");
  const totalCreditOriginal = creditReceivables.reduce((sum, item) => sum + item.original_amount, 0);
  const totalCreditPaid = creditReceivables.reduce((sum, item) => sum + item.total_paid, 0);
  const pendingCreditBalance = openReceivables.reduce((sum, item) => sum + item.balance_due, 0);

  return (
    <PublicStoreShell>
      <CustomerCreditNotificationToast notifications={creditAccount ? creditNotifications : []} />
      <section className="mx-auto max-w-6xl px-5 py-8">
        {confirmed ? (
          <div className="mb-4 rounded-lg border border-[#16a34a]/20 bg-[#f0fdf4] p-4 text-sm text-[#166534]">
            Correo electrónico confirmado correctamente. Tu cuenta ya está activa.
          </div>
        ) : null}

        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm text-black/50">Mi cuenta</p>
            <h1 className="mt-1 text-3xl font-semibold">{profile.full_name || profile.email}</h1>
            <p className="mt-2 text-sm text-black/60">Revisa tu perfil, compras, facturas y acceso mayorista.</p>
          </div>
          <LogoutButton />
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <section className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
                <UserRound size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Mi perfil</h2>
                <p className="text-sm text-black/55">Resumen de tu cuenta de cliente.</p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Info label="Nombre" value={profile.full_name || "Cliente"} />
              <Info label="Correo electrónico" value={profile.email ?? "No disponible"} />
              <Info label="Teléfono" value={accountSummary.phone || "No disponible"} />
              <Info label="Tipo de cuenta" value={visibleRole} />
              <Info label="Correo electrónico confirmado" value={accountSummary.emailConfirmed ? "Sí" : "No"} />
              <Info label="Registro" value={formatDate(accountSummary.registeredAt)} />
              <Info label="Total de pedidos" value={accountSummary.orderCount.toLocaleString("es-HN")} />
              <Info label="Total comprado" value={formatCurrency(accountSummary.totalPurchased)} />
              <Info label="Facturas disponibles" value={accountSummary.issuedInvoiceCount.toLocaleString("es-HN")} />
              <Info label="Estado mayorista" value={wholesaleLifecycleStatus} />
            </div>
          </section>

          <WholesaleAccountRequestCard initialState={wholesaleState} context="account" />
        </div>

        {wholesaleState.kind === "approved" ? (
          <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <p className="text-sm text-black/50">Estado mayorista</p>
                <h2 className="mt-1 text-xl font-semibold">{wholesaleLifecycleStatus}</h2>
                <p className="mt-2 text-sm text-black/60">
                  {wholesaleState.customerType === "existing"
                    ? "Cuenta mayorista aprobada. Puedes acceder a precios mayoristas sin requisito de primera compra mínima."
                    : "Cuenta mayorista aprobada. Para tu primera compra mayorista, el monto mínimo requerido es de L 10,000. Después de esa primera compra, podrás comprar cualquier monto."}
                </p>
              </div>
              <Link href="/catalogo" className="inline-flex rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white">
                Comprar ahora
              </Link>
            </div>
            {firstPurchaseRequirement && !firstPurchaseRequirement.completed ? (
              <div className="mt-4">
                <WholesaleRequirementSummary requirement={firstPurchaseRequirement} />
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Info label="Total final mínimo" value={formatCurrency(firstPurchaseRequirement.minimum)} />
                  <Info label="Total final acumulado" value={formatCurrency(firstPurchaseRequirement.accumulated)} />
                  <Info label="Total final faltante" value={formatCurrency(firstPurchaseRequirement.missing)} />
                </div>
              </div>
            ) : wholesaleState.customerType === "new" ? (
              <p className="mt-4 rounded-md bg-[#f0fdf4] p-3 text-sm font-medium text-[#166534]">
                Primera compra completada. Tus compras mayoristas posteriores no tienen monto mínimo.
              </p>
            ) : null}
          </section>
        ) : null}

        {creditAccount ? (
          <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <p className="text-sm text-black/50">Crédito comercial</p>
                <h2 className="mt-1 text-xl font-semibold">Crédito activo</h2>
                <p className="mt-2 text-sm text-black/60">
                  Puedes comprar con Crédito Comercial. Cada pedido muestra sus abonos y saldo pendiente.
                </p>
              </div>
              <Link href="/catalogo" className="inline-flex rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white">
                Comprar con crédito
              </Link>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Info label="Límite autorizado" value={formatCurrency(creditAccount.credit_limit)} />
              <Info label="Total crédito utilizado" value={formatCurrency(totalCreditOriginal)} />
              <Info label="Total abonado" value={formatCurrency(totalCreditPaid)} />
              <Info label="Saldo pendiente" value={formatCurrency(pendingCreditBalance)} />
              <Info label="Plazo de pago" value={`${creditAccount.terms_days} días`} />
            </div>
            {creditReceivables.length > 0 ? (
              <div className="mt-4 grid gap-2">
                {creditReceivables.slice(0, 10).map((item) => (
                  <div key={item.id} className="rounded-md border border-black/10 p-3 text-sm">
                    <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                      <div>
                        <p className="font-semibold">{item.order_number ? `Pedido ${item.order_number}` : item.order_id ? `Pedido ${item.order_id.slice(0, 8)}` : "Cuenta historica"}</p>
                        <p className="text-xs text-black/50">Fecha límite: {formatDate(item.due_date)}</p>
                      </div>
                      <span className="w-fit rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">
                        {creditStatusLabels[item.status] ?? "Abierto"}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <MiniInfo label="Total original" value={formatCurrency(item.original_amount)} />
                      <MiniInfo label="Total abonado" value={formatCurrency(item.total_paid)} />
                      <MiniInfo label="Saldo pendiente" value={formatCurrency(item.balance_due)} />
                    </div>
                    <div className="mt-3 rounded-md bg-[#f4f4f5] p-3">
                      <CreditPaymentHistory
                        payments={item.payments}
                        totalPaid={item.total_paid}
                        showRecordedBy={false}
                        showNotes={false}
                        balanceDue={item.balance_due}
                        status={item.status}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-md bg-[#f0fdf4] p-3 text-sm font-medium text-[#166534]">
                No tienes cuentas por cobrar.
              </p>
            )}
          </section>
        ) : null}

        <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
                <PackageCheck size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Mis pedidos recientes</h2>
                <p className="text-sm text-black/55">Últimas compras y estado de revisión.</p>
              </div>
            </div>
            <Link className="inline-flex rounded-md border border-black/10 px-3 py-2 text-sm font-medium" href="/mis-pedidos">
              Ver todos mis pedidos
            </Link>
          </div>

          {recentOrders.length === 0 ? (
            <EmptyState message="Todavía no has realizado compras." href="/catalogo" label="Ver catálogo" />
          ) : (
            <div className="mt-4 grid gap-3">
              {recentOrders.map((order) => {
                const trackingHref = order.tracking_code ? `/rastreo?codigo=${encodeURIComponent(order.tracking_code)}` : "/rastreo";

                return (
                  <article key={order.id} className="rounded-md border border-black/10 p-4">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div>
                        <p className="text-xs uppercase text-black/45">{formatDateTime(order.created_at)}</p>
                        <h3 className="mt-1 font-semibold">Pedido {order.order_number}</h3>
                        {order.payment_status === "pending" ? (
                          <p className="mt-1 text-sm text-black/55">Estamos revisando tu pago.</p>
                        ) : null}
                      </div>
                      <p className="text-lg font-semibold">{formatCurrency(order.total)}</p>
                    </div>

                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <MiniInfo label="Estado" value={orderStatusLabels[order.status] ?? order.status} />
                      <MiniInfo label="Pago" value={paymentStatusLabels[order.payment_status ?? "pending"] ?? "Pendiente"} />
                      <MiniInfo label="Factura" value={orderHasIssuedInvoice(order) ? "Disponible" : "Pendiente"} />
                      <MiniInfo label="Precio" value={order.price_mode === "wholesale" ? "Mayorista" : "Cliente"} />
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link className="inline-flex rounded-md border border-black/10 px-3 py-2 text-sm font-medium" href="/mis-pedidos">
                        Ver pedido
                      </Link>
                      <Link className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium" href={trackingHref}>
                        <Route size={16} />
                        Rastrear
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
                <FileText size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Mis facturas</h2>
                <p className="text-sm text-black/55">Solo aparecen facturas emitidas y disponibles para descarga.</p>
              </div>
            </div>
            <Link className="inline-flex rounded-md border border-black/10 px-3 py-2 text-sm font-medium" href="/facturas">
              Ver mis facturas
            </Link>
          </div>

          {issuedInvoices.length === 0 ? (
            <div className="mt-4 rounded-md bg-[#f4f4f5] p-4 text-sm text-black/60">
              Tu factura estará disponible cuando el pago sea confirmado y el equipo emita la factura.
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              {issuedInvoices.map((invoice) => (
                <article key={invoice.id} className="rounded-md border border-black/10 p-4">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div>
                      <p className="text-xs uppercase text-black/45">{formatDateTime(invoice.issuedAt)}</p>
                      <h3 className="mt-1 font-semibold">Factura {invoice.invoiceNumber}</h3>
                      <p className="mt-1 text-sm text-black/55">Pedido {invoice.orderNumber}</p>
                    </div>
                    <span className="w-fit rounded-md bg-[#f0fdf4] px-3 py-2 text-sm font-medium text-[#166534]">
                      {invoice.status === "anulada" || invoice.status === "cancelled" ? "Anulada" : "Emitida"}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <p className="font-semibold">{formatCurrency(invoice.total)}</p>
                    {invoiceIsIssued(invoice) ? <PublicInvoiceDownloadButton invoice={invoice} /> : null}
                  </div>
                </article>
              ))}
            </div>
          )}

          {pendingInvoiceOrders.length > 0 ? (
            <div className="mt-4 grid gap-2">
              {pendingInvoiceOrders.map((order) => (
                <p key={order.id} className="rounded-md bg-[#fff7ed] px-3 py-2 text-sm text-[#7c2d12]">
                  Pedido {order.order_number}: {pendingInvoiceMessage(order)}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
              <ShoppingBag size={18} />
            </div>
            <div>
              <h2 className="font-semibold">Acciones rápidas</h2>
              <p className="text-sm text-black/55">Atajos para seguir comprando y revisar tu operación.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <QuickLink href="/catalogo" label="Ver catálogo" />
            <QuickLink href="/mis-pedidos" label="Mis pedidos" />
            <QuickLink href="/facturas" label="Mis facturas" />
            <QuickLink href="/rastreo" label="Rastrear pedido" />
            {wholesaleState.kind === "regular" ? <QuickLink href="#mayoreo" label="Solicitar mayoreo" /> : null}
          </div>
        </section>
      </section>
    </PublicStoreShell>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 break-words font-medium">{value}</p>
    </div>
  );
}

function MiniInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function EmptyState({ message, href, label }: { message: string; href: string; label: string }) {
  return (
    <div className="mt-4 rounded-md bg-[#f4f4f5] p-4 text-sm text-black/60">
      <p>{message}</p>
      <Link href={href} className="mt-3 inline-flex rounded-md bg-[#080808] px-3 py-2 font-medium text-white">
        {label}
      </Link>
    </div>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex rounded-md border border-black/10 px-3 py-2 text-sm font-medium hover:bg-[#f4f4f5]">
      {label}
    </Link>
  );
}
