"use client";

import { Printer } from "lucide-react";
import styles from "./journal-entry-print-document.module.css";

export function JournalEntryPrintButton() {
  return (
    <button className={styles.printButton} type="button" onClick={() => window.print()}>
      <Printer aria-hidden="true" size={18} />
      Imprimir partida
    </button>
  );
}
