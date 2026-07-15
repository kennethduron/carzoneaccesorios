"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  linkCustomerPortalAccountAction,
  searchCustomersForPortalLinkAction,
  searchPortalAccountCandidatesAction,
  type PortalAccountCandidate,
  type PortalLinkCustomerCandidate,
} from "@/app/admin/crm/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { roleLabels } from "@/lib/auth/roles";

type CustomerPortalLinkWorkspaceProps = {
  initialCustomer?: PortalLinkCustomerCandidate | null;
  compact?: boolean;
};

export function CustomerPortalLinkWorkspace({
  initialCustomer = null,
  compact = false,
}: CustomerPortalLinkWorkspaceProps) {
  const router = useRouter();
  const toast = useToast();
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<PortalLinkCustomerCandidate[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<PortalLinkCustomerCandidate | null>(initialCustomer);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountResults, setAccountResults] = useState<PortalAccountCandidate[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<PortalAccountCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [searchingAccounts, setSearchingAccounts] = useState(false);
  const [linking, setLinking] = useState(false);

  async function searchCustomers(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchingCustomers) return;
    setSearchingCustomers(true);
    setMessage(null);
    try {
      const result = await searchCustomersForPortalLinkAction(customerQuery);
      setCustomerResults(result.customers);
      setMessage(result.message);
    } finally {
      setSearchingCustomers(false);
    }
  }

  async function searchAccounts(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCustomer || searchingAccounts) return;
    setSearchingAccounts(true);
    setSelectedAccount(null);
    setConfirmed(false);
    setMessage(null);
    try {
      const result = await searchPortalAccountCandidatesAction(selectedCustomer.id, accountQuery);
      setAccountResults(result.candidates);
      setMessage(result.message);
    } finally {
      setSearchingAccounts(false);
    }
  }

  async function confirmLink() {
    if (!selectedCustomer || !selectedAccount || linking) return;
    setLinking(true);
    setMessage(null);
    try {
      const result = await linkCustomerPortalAccountAction({
        customerId: selectedCustomer.id,
        userId: selectedAccount.id,
        reason,
        confirmed,
      });
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
      if (result.ok) {
        setSelectedCustomer({
          ...selectedCustomer,
          linked: true,
          linkedAccountEmail: selectedAccount.email,
        });
        setSelectedAccount(null);
        setAccountResults([]);
        setConfirmed(false);
        setReason("");
        router.refresh();
      }
    } finally {
      setLinking(false);
    }
  }

  return (
    <section className={compact ? "space-y-4" : "rounded-lg border border-black/10 bg-white p-5 shadow-sm"}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-black/45">Identidad del portal</p>
        <h2 className="mt-1 text-lg font-semibold">Vinculación manual de cuenta web</h2>
        <p className="mt-2 text-sm text-black/60">
          La coincidencia de nombre, correo, teléfono o RTN solo sirve para revisar. Nunca selecciona ni vincula una cuenta automáticamente.
        </p>
      </div>

      {!initialCustomer ? (
        <div className="mt-4">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={searchCustomers}>
            <Input
              value={customerQuery}
              onChange={(event) => setCustomerQuery(event.target.value)}
              placeholder="Buscar cliente por nombre, correo o teléfono"
              disabled={searchingCustomers || linking}
              aria-label="Buscar cliente operativo"
            />
            <Button type="submit" disabled={searchingCustomers || linking || customerQuery.trim().length < 2}>
              {searchingCustomers ? "Buscando..." : "Buscar cliente"}
            </Button>
          </form>
          {customerResults.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {customerResults.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => {
                    setSelectedCustomer(customer);
                    setCustomerResults([]);
                    setAccountResults([]);
                    setSelectedAccount(null);
                    setMessage(null);
                  }}
                  className="rounded-md border border-black/10 p-3 text-left hover:bg-[#f4f4f5]"
                >
                  <span className="font-semibold">{customer.displayName}</span>
                  <span className="mt-1 block text-xs text-black/55">
                    {customer.email || "Sin correo"} · {customer.phone || "Sin teléfono"} · {customer.linked ? "Ya vinculado" : "Sin cuenta web"}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedCustomer ? (
        <div className="mt-4 rounded-md border border-black/10 p-4">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
            <div>
              <p className="font-semibold">{selectedCustomer.displayName}</p>
              <p className="mt-1 text-sm text-black/55">{selectedCustomer.email || "Correo no registrado"}</p>
              <p className="text-sm text-black/55">{selectedCustomer.phone || "Teléfono no registrado"}</p>
              <p className="text-sm text-black/55">{selectedCustomer.taxId || "RTN no registrado"}</p>
            </div>
            <span className="w-fit rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">
              {selectedCustomer.linked ? "Cuenta web vinculada" : "Sin cuenta web"}
            </span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Summary label="Pedidos" value={selectedCustomer.orderCount.toLocaleString("es-HN")} />
            <Summary label="CxC" value={selectedCustomer.receivableCount.toLocaleString("es-HN")} />
            <Summary label="Crédito" value={selectedCustomer.hasCreditAccount ? "Configurado" : "No configurado"} />
          </div>
          {selectedCustomer.linked ? (
            <p className="mt-3 rounded-md bg-[#f0fdf4] p-3 text-sm text-[#166534]">
              Este customer ya está vinculado{selectedCustomer.linkedAccountEmail ? " a " + selectedCustomer.linkedAccountEmail : ""}. Esta fase no permite desvincular.
            </p>
          ) : !selectedCustomer.active || ["inactive", "disabled"].includes(selectedCustomer.status) ? (
            <p className="mt-3 rounded-md bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
              El customer no está activo y no puede vincularse.
            </p>
          ) : (
            <>
              <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={searchAccounts}>
                <Input
                  value={accountQuery}
                  onChange={(event) => setAccountQuery(event.target.value)}
                  placeholder="Buscar cuenta web por correo, nombre o usuario"
                  disabled={searchingAccounts || linking}
                  aria-label="Buscar cuenta web"
                />
                <Button type="submit" disabled={searchingAccounts || linking || accountQuery.trim().length < 3}>
                  {searchingAccounts ? "Buscando..." : "Buscar cuenta web"}
                </Button>
              </form>

              {accountResults.length > 0 ? (
                <div className="mt-3 grid gap-2">
                  {accountResults.map((account) => {
                    const unavailable = !account.active || !account.authExists || account.linkedToAnotherCustomer;
                    return (
                      <button
                        key={account.id}
                        type="button"
                        disabled={unavailable || linking}
                        onClick={() => {
                          setSelectedAccount(account);
                          setConfirmed(false);
                        }}
                        className="rounded-md border border-black/10 p-3 text-left disabled:cursor-not-allowed disabled:opacity-55 hover:bg-[#f4f4f5]"
                      >
                        <span className="font-semibold">{account.fullName || account.username || "Cuenta web"}</span>
                        <span className="mt-1 block text-sm text-black/55">{account.email || "Sin correo visible"}</span>
                        <span className="mt-1 block text-xs text-black/45">
                          {account.role ? roleLabels[account.role] : "Rol no registrado"} ·{" "}
                          {account.linkedToThisCustomer
                            ? "Ya vinculada a este customer"
                            : account.linkedToAnotherCustomer
                              ? "Vinculada a otro customer"
                              : account.active && account.authExists
                                ? "Disponible para revisión"
                                : "Cuenta no disponible"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {selectedAccount ? (
                <div className="mt-4 rounded-md border border-[#f59e0b]/30 bg-[#fffbeb] p-4">
                  <p className="font-semibold">Confirmación explícita</p>
                  <p className="mt-1 text-sm text-[#78350f]">
                    Vincularás este customer operativo con {selectedAccount.email || selectedAccount.fullName || "la cuenta web seleccionada"}.
                    La cuenta podrá consultar la información comercial asociada a este customer.
                  </p>
                  <label className="mt-3 block text-sm font-medium">
                    Motivo de la vinculación
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      minLength={10}
                      maxLength={500}
                      rows={3}
                      disabled={linking}
                      className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 outline-none"
                      placeholder="Describe cómo se verificó la identidad del cliente."
                    />
                  </label>
                  <label className="mt-3 flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={linking}
                      className="mt-1"
                    />
                    <span>Confirmo que revisé la identidad y seleccioné manualmente la cuenta web correcta.</span>
                  </label>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={confirmLink}
                      disabled={linking || !confirmed || reason.trim().length < 10}
                    >
                      {linking ? "Vinculando cuenta..." : "Confirmar vinculación"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setSelectedAccount(null);
                        setConfirmed(false);
                      }}
                      disabled={linking}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {message ? <p className="mt-3 text-sm text-black/60" role="status">{message}</p> : null}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
