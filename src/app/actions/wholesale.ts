"use server";

import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { WholesaleAccessState, WholesaleAccount, WholesaleAccountStatus } from "@/types/wholesale";

type CustomerAccessRow = {
  id: string;
  business_name: string | null;
  company_name: string | null;
  contact_name: string;
  notes: string | null;
  is_wholesale: boolean;
  wholesale_status: WholesaleAccountStatus | "none" | null;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
};

function toAccount(customer: CustomerAccessRow): WholesaleAccount {
  const businessName = customer.business_name || customer.company_name || customer.contact_name || "Cuenta mayorista";

  return {
    id: customer.id,
    customerId: customer.id,
    customerName: customer.contact_name,
    businessName,
    status: "approved",
  };
}

function getWholesaleStatus(customer: CustomerAccessRow): WholesaleAccountStatus | "none" {
  if (customer.wholesale_status) {
    return customer.wholesale_status;
  }

  if (customer.is_wholesale && customer.active && customer.status === "active") {
    return "approved";
  }

  if (customer.is_wholesale && (!customer.active || customer.status === "disabled")) {
    return "suspended";
  }

  if (customer.status === "pending_account" || Boolean(customer.notes?.includes("[SOLICITUD_MAYOREO]"))) {
    return "pending";
  }

  if (customer.is_wholesale && customer.status === "inactive") {
    return "rejected";
  }

  return "none";
}

function guestWholesaleState(): WholesaleAccessState {
  return {
    kind: "guest",
    title: "Acceso mayorista",
    message: "Inicia sesion o solicita acceso mayorista para que el equipo apruebe tu cuenta.",
    canEnterCode: false,
    account: null,
  };
}

export async function getWholesaleAccessStateAction(): Promise<WholesaleAccessState> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return guestWholesaleState();
  }

  const admin = getSupabaseAdminClient();
  const { data: customers, error } = await admin
    .from("customers")
    .select("id, business_name, company_name, contact_name, notes, is_wholesale, wholesale_status, status, active")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .returns<CustomerAccessRow[]>();

  if (error) {
    await writeErrorLog({
      route: "/",
      action: "wholesale.access_state_failed",
      errorMessage: error.message,
      metadata: { user_id: user.id },
    });
    return {
      kind: "regular",
      title: "Acceso mayorista",
      message: "Tu cuenta aun no tiene acceso mayorista. Puedes solicitarlo para revision.",
      canEnterCode: false,
      account: null,
    };
  }

  const customerRows = customers ?? [];
  const approvedCustomer = customerRows.find((customer) => getWholesaleStatus(customer) === "approved" && customer.active);

  if (approvedCustomer) {
    return {
      kind: "approved",
      title: "Mayorista aprobado",
      message: "Precio mayorista activo automaticamente para esta cuenta.",
      canEnterCode: false,
      account: toAccount(approvedCustomer),
    };
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "suspended")) {
    return {
      kind: "suspended",
      title: "Acceso mayorista suspendido",
      message: "Tu acceso mayorista esta suspendido. Puedes comprar al detalle o contactar al equipo comercial.",
      canEnterCode: false,
      account: null,
    };
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "rejected")) {
    return {
      kind: "rejected",
      title: "Solicitud mayorista rechazada",
      message: "Tu solicitud mayorista no fue aprobada. Contacta al equipo comercial si necesitas una revision.",
      canEnterCode: false,
      account: null,
    };
  }

  if (customerRows.some((customer) => getWholesaleStatus(customer) === "pending")) {
    return {
      kind: "pending",
      title: "Solicitud mayorista en revision",
      message: "Aun no puedes ver precios mayoristas. Te contactaremos cuando la cuenta sea aprobada.",
      canEnterCode: false,
      account: null,
    };
  }

  return {
    kind: "regular",
    title: "Acceso mayorista",
    message: "Tu cuenta aun no tiene acceso mayorista. Puedes solicitarlo para revision.",
    canEnterCode: false,
    account: null,
  };
}
