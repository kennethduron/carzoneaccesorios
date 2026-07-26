const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const SUPPORTED_METHODS = new Set(["cash", "bank_transfer", "card"]);

function optionValue(argv, name) {
  const exact = `--${name}`;
  const withEquals = `${exact}=`;
  const matches = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === exact) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`La opcion ${exact} requiere un valor.`);
      matches.push(value);
      index += 1;
    } else if (argument.startsWith(withEquals)) {
      matches.push(argument.slice(withEquals.length));
    }
  }
  if (matches.length > 1) throw new Error(`La opcion ${exact} solo puede indicarse una vez.`);
  return matches[0] ?? null;
}

function assertUuid(value, label) {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} requiere un UUID completo y valido.`);
  }
  return value.toLowerCase();
}

function parseDate(value, label) {
  if (!value || !DATE_PATTERN.test(value)) {
    throw new Error(`${label} requiere una fecha YYYY-MM-DD valida.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} requiere una fecha YYYY-MM-DD valida.`);
  }
  return value;
}

export function decimalToMinorUnits(value, label = "El importe") {
  const text = String(value ?? "").trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match) {
    throw new Error(`${label} requiere un decimal positivo con un maximo de dos decimales.`);
  }
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor <= 0n) throw new Error(`${label} debe ser mayor que cero.`);
  return minor;
}

function decimalToMinorUnitsOrZero(value) {
  const text = String(value ?? "0").trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match) throw new Error("La base devolvio un importe contable no canonico.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export function parseRepairArgs(argv) {
  const supportedOptions = new Set([
    "--apply",
    "--payment-id",
    "--expected-event-id",
    "--expected-amount",
    "--expected-date",
    "--expected-method",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.split("=", 1)[0];
    if (!supportedOptions.has(name)) throw new Error(`Opcion no reconocida: ${name}.`);
    if (name !== "--apply" && argument === name) index += 1;
  }

  const apply = argv.includes("--apply");
  const paymentIdRaw = optionValue(argv, "payment-id");
  if (!paymentIdRaw) {
    const prefix = apply
      ? "La reparacion productiva requiere --payment-id con un UUID completo."
      : "El preview dirigido requiere --payment-id con un UUID completo.";
    throw new Error(`${prefix}\nNo se ejecuto ninguna modificacion.`);
  }
  const paymentId = assertUuid(paymentIdRaw, "--payment-id");
  const expectedEventIdRaw = optionValue(argv, "expected-event-id");
  const expectedAmountRaw = optionValue(argv, "expected-amount");
  const expectedDateRaw = optionValue(argv, "expected-date");
  const expectedMethodRaw = optionValue(argv, "expected-method");
  if (apply && (!expectedAmountRaw || !expectedDateRaw || !expectedMethodRaw)) {
    throw new Error(
      "Para --apply son obligatorios --expected-amount, --expected-date y --expected-method.\n"
      + "No se ejecuto ninguna modificacion.",
    );
  }
  const expectedMethod = expectedMethodRaw?.trim() ?? null;
  if (expectedMethodRaw && (!METHOD_PATTERN.test(expectedMethod) || expectedMethod !== expectedMethodRaw)) {
    throw new Error("--expected-method requiere un metodo canonico sin espacios.");
  }
  return {
    apply,
    paymentId,
    expectedEventId: expectedEventIdRaw ? assertUuid(expectedEventIdRaw, "--expected-event-id") : null,
    expectedAmount: expectedAmountRaw
      ? decimalToMinorUnits(expectedAmountRaw, "--expected-amount")
      : null,
    expectedDate: expectedDateRaw ? parseDate(expectedDateRaw, "--expected-date") : null,
    expectedMethod,
  };
}

export function hnDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function maskId(value) {
  return typeof value === "string" && value.length > 8 ? `${value.slice(0, 8)}...` : value;
}

async function rows(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

function firstRelation(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function mappingApplies(mapping, date) {
  const account = firstRelation(mapping.accounting_accounts);
  return Boolean(
    mapping.is_active
    && account?.is_active
    && (!mapping.effective_from || mapping.effective_from <= date)
    && (!mapping.effective_to || mapping.effective_to >= date),
  );
}

function mappingSummary(mapping) {
  if (!mapping) return null;
  const account = firstRelation(mapping.accounting_accounts);
  return {
    mapping_type: mapping.mapping_type,
    source_key: mapping.source_key,
    account_id: maskId(mapping.account_id),
    account_code: account?.code ?? null,
    account_name: account?.name ?? null,
  };
}

function manualEquivalent(manualLines, payment) {
  const grouped = new Map();
  for (const line of manualLines) {
    const entry = firstRelation(line.journal_entries);
    if (!entry) continue;
    const current = grouped.get(line.journal_entry_id) ?? {
      id: line.journal_entry_id,
      debit: 0n,
      credit: 0n,
      customerIds: new Set(),
    };
    current.debit += decimalToMinorUnitsOrZero(line.debit);
    current.credit += decimalToMinorUnitsOrZero(line.credit);
    if (line.customer_id) current.customerIds.add(line.customer_id);
    grouped.set(line.journal_entry_id, current);
  }
  const amount = decimalToMinorUnits(payment.amount);
  return [...grouped.values()].filter((entry) => (
    entry.debit === amount
    && entry.credit === amount
    && (entry.customerIds.size === 0 || entry.customerIds.has(payment.customer_id))
  ));
}

export async function collectScopedReceivablePaymentPreview(service, paymentId) {
  assertUuid(paymentId, "--payment-id");
  const payments = await rows(
    service.from("accounts_receivable_payments")
      .select(
        "id,receivable_id,customer_id,amount,payment_method,received_at,voided_at,"
        + "balance_before,balance_after,created_at",
      )
      .eq("id", paymentId).limit(2),
    "No se pudo consultar el abono dirigido",
  );
  if (payments.length !== 1) {
    return {
      paymentId, payments, receivables: [], events: [], outbox: [],
      journalEntries: [], journalLines: [], manualEntries: [], mappings: [],
      periods: [], controlEvents: [], auditRows: [], possibleManualEntries: [],
      debitMapping: null, creditMapping: null, paymentDate: null, closedPeriod: false,
    };
  }

  const payment = payments[0];
  const paymentDate = hnDate(payment.received_at);
  const [
    receivables, events, outbox, mappings, periods, controlEvents, auditRows, manualLines,
  ] = await Promise.all([
    rows(
      service.from("accounts_receivable")
        .select("id,balance_due,status,paid_at,original_amount,order_id")
        .eq("id", payment.receivable_id).limit(2),
      "No se pudo consultar la cuenta por cobrar dirigida",
    ),
    rows(
      service.from("financial_events")
        .select(
          "id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id,"
          + "occurred_at,source_snapshot,validation_errors,created_at",
        )
        .eq("source_type", "receivable_payment").eq("source_id", payment.id)
        .eq("event_purpose", "receivable_payment").eq("posting_version", "v1").limit(2),
      "No se pudo consultar el evento exacto",
    ),
    rows(
      service.from("accounting_outbox")
        .select("id,source_type,source_id,event_purpose,posting_version,status,attempts,last_error,processed_at")
        .eq("source_type", "receivable_payment").eq("source_id", payment.id)
        .eq("event_purpose", "receivable_payment").eq("posting_version", "v1").limit(2),
      "No se pudo consultar la outbox exacta",
    ),
    rows(
      service.from("accounting_mappings")
        .select(
          "id,mapping_type,source_key,account_id,priority,is_active,effective_from,effective_to,"
          + "accounting_accounts!inner(id,code,name,is_active)",
        )
        .in("mapping_type", ["payment_method", "receivable"])
        .in("source_key", [payment.payment_method, "accounts_receivable"])
        .order("priority", { ascending: true }).order("created_at", { ascending: true }),
      "No se pudieron consultar los mapeos dirigidos",
    ),
    rows(
      service.from("accounting_periods").select("id,start_date,end_date,status")
        .lte("start_date", paymentDate).gte("end_date", paymentDate).limit(2),
      "No se pudo consultar el periodo contable",
    ),
    rows(
      service.from("financial_events")
        .select("id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id")
        .eq("source_type", "accounts_receivable").eq("source_id", payment.receivable_id)
        .eq("event_purpose", "receivable_paid").eq("posting_version", "v1").limit(2),
      "No se pudo consultar el evento de control",
    ),
    rows(
      service.from("accounting_event_log")
        .select("id,event_type,entity_type,entity_id,source_type,source_id,created_at")
        .eq("source_type", "receivable_payment").eq("source_id", payment.id)
        .order("created_at", { ascending: true }),
      "No se pudo consultar la auditoria dirigida",
    ),
    rows(
      service.from("journal_entry_lines")
        .select(
          "journal_entry_id,customer_id,debit,credit,"
          + "journal_entries!inner(id,entry_date,status,source_type)",
        )
        .eq("journal_entries.entry_date", paymentDate).is("journal_entries.source_type", null),
      "No se pudieron comprobar equivalentes manuales",
    ),
  ]);

  const eventJournalIds = events.map((event) => event.journal_entry_id).filter(Boolean);
  const journalEntries = eventJournalIds.length > 0
    ? await rows(
        service.from("journal_entries")
          .select("id,entry_number,entry_date,description,status,source_type,source_id,posted_at,posted_by")
          .in("id", eventJournalIds),
        "No se pudo consultar la partida vinculada",
      )
    : [];
  const journalLines = eventJournalIds.length > 0
    ? await rows(
        service.from("journal_entry_lines")
          .select("id,journal_entry_id,account_id,debit,credit,accounting_accounts!inner(code,name)")
          .in("journal_entry_id", eventJournalIds),
        "No se pudieron consultar las lineas de la partida",
      )
    : [];
  const applicableMappings = mappings.filter((mapping) => mappingApplies(mapping, paymentDate));
  const debitMapping = applicableMappings.find(
    (mapping) => mapping.mapping_type === "payment_method"
      && mapping.source_key === payment.payment_method,
  ) ?? null;
  const creditMapping = applicableMappings.find(
    (mapping) => mapping.mapping_type === "receivable"
      && mapping.source_key === "accounts_receivable",
  ) ?? null;
  return {
    paymentId, payments, receivables, events, outbox, journalEntries, journalLines,
    manualEntries: manualLines, mappings, periods, controlEvents, auditRows,
    possibleManualEntries: manualEquivalent(manualLines, payment),
    debitMapping, creditMapping, paymentDate,
    closedPeriod: periods.some((period) => period.status === "closed"),
  };
}

export function scopedPublicReport(preview) {
  const payment = preview.payments[0] ?? null;
  const event = preview.events[0] ?? null;
  const outbox = preview.outbox[0] ?? null;
  const journal = preview.journalEntries[0] ?? null;
  const repairRequired = Boolean(
    payment && !payment.voided_at && preview.events.length === 1
    && !event?.journal_entry_id && preview.possibleManualEntries.length === 0,
  );
  const noWrites = {
    payment: 0, financial_events: 0, accounting_outbox: 0,
    journal_entries: 0, published_entries: 0,
  };
  return {
    mode: "READ_ONLY_PREVIEW",
    scope: "SINGLE_RECEIVABLE_PAYMENT",
    selected_records: preview.payments.length,
    payment: payment ? {
      id: maskId(payment.id),
      receivable_id: maskId(payment.receivable_id),
      active: payment.voided_at === null,
      voided_at: payment.voided_at,
      amount_hnl: String(payment.amount),
      effective_date: preview.paymentDate,
      method: payment.payment_method,
      balance_before_hnl: payment.balance_before === null ? null : String(payment.balance_before),
      balance_after_hnl: payment.balance_after === null ? null : String(payment.balance_after),
    } : null,
    exact_event: {
      count: preview.events.length,
      id: maskId(event?.id ?? null),
      status: event?.status ?? null,
      source_type: event?.source_type ?? null,
      source_id: maskId(event?.source_id ?? null),
      event_purpose: event?.event_purpose ?? null,
      posting_version: event?.posting_version ?? null,
      journal_entry_id: maskId(event?.journal_entry_id ?? null),
    },
    outbox: {
      count: preview.outbox.length,
      id: maskId(outbox?.id ?? null),
      status: outbox?.status ?? null,
      attempts: outbox?.attempts ?? null,
      last_error: outbox?.last_error ?? null,
    },
    journal_entry: {
      count: preview.journalEntries.length,
      id: maskId(journal?.id ?? null),
      status: journal?.status ?? null,
      entry_date: journal?.entry_date ?? null,
      published: journal ? journal.status === "publicada" : false,
    },
    possible_manual_equivalent: preview.possibleManualEntries.length > 0,
    mappings: {
      debit: mappingSummary(preview.debitMapping),
      credit: mappingSummary(preview.creditMapping),
    },
    accounting_period: { rows: preview.periods.length, closed: preview.closedPeriod },
    receivable_paid_control: preview.controlEvents.map((control) => ({
      id: maskId(control.id),
      status: control.status,
      journal_entry_id: maskId(control.journal_entry_id),
    })),
    repair: {
      required: repairRequired,
      action: repairRequired ? "reconcile_outbox_and_create_draft" : "none",
      proposed_writes: repairRequired
        ? {
            ...noWrites,
            accounting_outbox: preview.outbox.length === 0 ? 1 : 0,
            journal_entries: 1,
          }
        : noWrites,
    },
    safety: {
      exact_payment_query: true,
      global_collection: false,
      writes_executed: false,
      pii_masked: true,
      receivable_paid_excluded: true,
    },
  };
}

function blocked(message) {
  throw new Error(`${message}\nCero modificaciones.`);
}

export function validateApplyPreflight(preview, options) {
  if (!options?.apply) blocked("La validacion de escritura requiere --apply.");
  if (preview.payments.length === 0) blocked("Abono no encontrado.");
  if (preview.payments.length !== 1) blocked("Resultado ambiguo. Reparacion bloqueada.");
  const payment = preview.payments[0];
  if (payment.id.toLowerCase() !== options.paymentId) blocked("El abono consultado no coincide con --payment-id.");
  if (payment.voided_at) blocked("El abono fue anulado.");
  if (!SUPPORTED_METHODS.has(payment.payment_method)) blocked("El metodo de pago no esta soportado.");
  const amount = decimalToMinorUnits(payment.amount);
  if (options.expectedAmount === null || amount !== options.expectedAmount) {
    blocked("Los datos actuales no coinciden con la autorizacion: importe.");
  }
  if (!options.expectedDate || preview.paymentDate !== options.expectedDate) {
    blocked("Los datos actuales no coinciden con la autorizacion: fecha.");
  }
  if (!options.expectedMethod || payment.payment_method !== options.expectedMethod) {
    blocked("Los datos actuales no coinciden con la autorizacion: metodo.");
  }
  if (preview.receivables.length !== 1) blocked("La cuenta por cobrar relacionada no es unica.");
  if (preview.events.length === 0) blocked("El evento financiero exacto no existe.");
  if (preview.events.length !== 1) blocked("Existen multiples eventos financieros exactos.");
  const event = preview.events[0];
  if (
    event.source_type !== "receivable_payment"
    || event.source_id.toLowerCase() !== payment.id.toLowerCase()
    || event.event_purpose !== "receivable_payment"
    || event.posting_version !== "v1"
  ) {
    blocked("El evento financiero no cumple el contrato receivable_payment/v1.");
  }
  if (event.source_snapshot?.event_type === "receivable_paid" || event.event_purpose === "receivable_paid") {
    blocked("El evento receivable_paid esta excluido de la reparacion.");
  }
  if (options.expectedEventId && event.id.toLowerCase() !== options.expectedEventId) {
    blocked("El evento actual no coincide con --expected-event-id.");
  }
  if (event.journal_entry_id || preview.journalEntries.length > 0) {
    blocked("El abono ya tiene una partida vinculada.");
  }
  if (!["pending", "ready", "failed"].includes(event.status)) {
    blocked(`El estado del evento no es reparable: ${event.status}.`);
  }
  if (preview.possibleManualEntries.length > 0) blocked("Existe una posible partida manual equivalente.");
  if (!preview.debitMapping) blocked(`Falta el mapeo payment_method:${payment.payment_method}.`);
  if (!preview.creditMapping) blocked("Falta el mapeo receivable:accounts_receivable.");
  if (preview.closedPeriod) blocked("El periodo contable esta cerrado.");
  if (preview.periods.length !== 1 || preview.periods[0].status !== "open") {
    blocked("No existe un unico periodo contable abierto para la fecha.");
  }
  if (preview.outbox.length > 1) blocked("Existen multiples outboxes exactas.");
  if (preview.outbox[0]?.status === "processing") blocked("La outbox esta siendo procesada.");
  if (preview.controlEvents.some((control) => (
    control.event_purpose !== "receivable_paid"
    || control.status !== "skipped"
    || control.journal_entry_id
  ))) blocked("El evento de control receivable_paid no conserva su estado omitido.");
  return { payment, event };
}

export function assertPostRepair(before, after) {
  if (after.payments.length !== 1 || after.events.length !== 1 || after.outbox.length !== 1) {
    throw new Error("La validacion posterior encontro conteos inesperados.");
  }
  if (after.journalEntries.length !== 1) throw new Error("La reparacion no dejo exactamente una partida.");
  const beforePayment = before.payments[0];
  const afterPayment = after.payments[0];
  for (const field of [
    "id", "receivable_id", "customer_id", "amount", "payment_method",
    "received_at", "voided_at", "balance_before", "balance_after",
  ]) {
    if (String(afterPayment[field]) !== String(beforePayment[field])) {
      throw new Error(`La reparacion modifico el abono: ${field}.`);
    }
  }
  if (before.receivables.length !== 1 || after.receivables.length !== 1) {
    throw new Error("La cuenta por cobrar relacionada no es unica.");
  }
  for (const field of ["id", "balance_due", "status", "paid_at", "original_amount", "order_id"]) {
    if (String(after.receivables[0][field]) !== String(before.receivables[0][field])) {
      throw new Error(`La reparacion modifico la cuenta por cobrar: ${field}.`);
    }
  }
  if (JSON.stringify(after.controlEvents) !== JSON.stringify(before.controlEvents)) {
    throw new Error("El evento de control receivable_paid fue modificado.");
  }
  if (after.events[0].id !== before.events[0].id) throw new Error("La reparacion no reutilizo el evento existente.");
  if (after.events[0].journal_entry_id !== after.journalEntries[0].id) {
    throw new Error("El evento no quedo vinculado a la partida.");
  }
  if (after.outbox[0].status !== "completed" || after.outbox[0].last_error) {
    throw new Error("La outbox no quedo completada limpiamente.");
  }
  const journal = after.journalEntries[0];
  if (journal.status !== "borrador" || journal.posted_at || journal.posted_by) {
    throw new Error("La partida no quedo como borrador sin publicar.");
  }
  if (journal.entry_date !== after.paymentDate) throw new Error("La fecha de la partida no coincide con el abono.");
  const debit = after.journalLines.reduce(
    (sum, line) => sum + decimalToMinorUnitsOrZero(line.debit), 0n,
  );
  const credit = after.journalLines.reduce(
    (sum, line) => sum + decimalToMinorUnitsOrZero(line.credit), 0n,
  );
  const amount = decimalToMinorUnits(afterPayment.amount);
  if (debit !== amount || credit !== amount || debit !== credit) {
    throw new Error("La partida no esta balanceada por el importe exacto del abono.");
  }
  if (after.controlEvents.some((control) => control.status !== "skipped" || control.journal_entry_id)) {
    throw new Error("El evento de control receivable_paid fue modificado.");
  }
  return {
    existing_event_reused: true,
    payment_unchanged: true,
    outbox_completed: true,
    journal_entry_id: journal.id,
    journal_status: journal.status,
    published: false,
    total_debits_minor: debit.toString(),
    total_credits_minor: credit.toString(),
    difference_minor: (debit - credit).toString(),
  };
}
