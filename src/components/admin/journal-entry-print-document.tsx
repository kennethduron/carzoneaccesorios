import Link from "next/link";
import { JournalEntryPrintButton } from "@/components/admin/journal-entry-print-button";
import { buildJournalEntryViewerHref, journalEntryStatusLabel, journalSourceLabel } from "@/lib/accounting-navigation";
import { formatCivilDate } from "@/lib/civil-date";
import type { JournalEntryViewerData } from "@/types/accounting";
import type { PublicCompanySettings } from "@/types/settings";
import { formatCurrency } from "@/utils/pricing";
import styles from "./journal-entry-print-document.module.css";

type JournalEntryPrintDocumentProps = {
  data: JournalEntryViewerData;
  company: PublicCompanySettings;
};

function nonempty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

export function JournalEntryPrintDocument({ data, company }: JournalEntryPrintDocumentProps) {
  const { entry, reversalRelation } = data;
  const companyName = nonempty(company.trade_name) ?? nonempty(company.company_name) ?? "Car Zone Accesorios";
  const legalName = nonempty(company.legal_business_name);
  const companyDetails = [
    nonempty(company.business_rtn) ? `RTN: ${nonempty(company.business_rtn)}` : null,
    nonempty(company.business_address),
    nonempty(company.customer_service_phone),
    nonempty(company.customer_service_email),
  ].filter((value): value is string => Boolean(value));

  return (
    <main className={styles.viewport}>
      <div className={styles.screenActions} aria-label="Acciones de impresión">
        <Link className={styles.backLink} href={buildJournalEntryViewerHref(entry.id)}>
          Volver a la partida
        </Link>
        <JournalEntryPrintButton />
      </div>

      <article className={styles.sheet} aria-labelledby="journal-entry-print-title">
        <header className={styles.documentHeader}>
          <div className={styles.companyBlock}>
            <p className={styles.companyName}>{companyName}</p>
            {legalName && legalName !== companyName ? <p>{legalName}</p> : null}
            {companyDetails.map((detail) => <p key={detail}>{detail}</p>)}
          </div>
          <div className={styles.titleBlock}>
            <p className={styles.eyebrow}>Documento contable</p>
            <h1 id="journal-entry-print-title">Partida contable</h1>
            <p className={styles.entryNumber}>{entry.entry_number}</p>
          </div>
        </header>

        <dl className={styles.metadata} aria-label="Datos de la partida">
          <div><dt>Fecha</dt><dd>{formatCivilDate(entry.entry_date)}</dd></div>
          <div><dt>Estado</dt><dd>{journalEntryStatusLabel(entry.status)}</dd></div>
          <div><dt>Origen</dt><dd>{journalSourceLabel(entry.source_type)}</dd></div>
          <div><dt>Creada por</dt><dd>{data.creatorName}</dd></div>
          {data.postedByName ? <div><dt>Publicada por</dt><dd>{data.postedByName}</dd></div> : null}
          {entry.source_id ? <div><dt>Referencia</dt><dd className={styles.wrapAnywhere}>{entry.source_id}</dd></div> : null}
        </dl>

        <section className={styles.concept} aria-labelledby="journal-entry-concept">
          <h2 id="journal-entry-concept">Concepto</h2>
          <p>{entry.description}</p>
        </section>

        {reversalRelation ? (
          <aside className={styles.reversal} aria-label="Relación de reversión">
            <strong>{reversalRelation.direction === "reversal_of" ? "Reversión de" : "Reversada por"}:</strong>{" "}
            {reversalRelation.entryNumber} · {formatCivilDate(reversalRelation.entryDate)} · {journalEntryStatusLabel(reversalRelation.status)}
            {reversalRelation.reason ? <span> · Motivo: {reversalRelation.reason}</span> : null}
          </aside>
        ) : null}

        <section className={styles.linesSection} aria-labelledby="journal-entry-lines">
          <h2 id="journal-entry-lines" className={styles.visuallyHidden}>Detalle contable</h2>
          <div className={styles.tableFrame}>
            <table>
              <colgroup>
                <col className={styles.codeColumn} />
                <col className={styles.accountColumn} />
                <col className={styles.memoColumn} />
                <col className={styles.amountColumn} />
                <col className={styles.amountColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Código</th>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Descripción</th>
                  <th scope="col" className={styles.numeric}>Débito</th>
                  <th scope="col" className={styles.numeric}>Crédito</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((line) => (
                  <tr key={line.id} data-journal-line-id={line.id}>
                    <td className={styles.accountCode}>{line.account?.code ?? "—"}</td>
                    <td>{line.account?.name ?? "Cuenta no disponible"}</td>
                    <td>{line.description || "—"}</td>
                    <td className={styles.numeric}>{formatCurrency(line.debit)}</td>
                    <td className={styles.numeric}>{formatCurrency(line.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>Totales</th>
                  <td className={styles.numeric}>{formatCurrency(entry.total_debit)}</td>
                  <td className={styles.numeric}>{formatCurrency(entry.total_credit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <footer className={styles.documentFooter}>
          <p>Documento generado desde la partida contable registrada.</p>
          <p className={styles.recordId}>ID: {entry.id}</p>
        </footer>
      </article>
    </main>
  );
}
