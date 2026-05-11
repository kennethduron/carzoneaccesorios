export async function createPdfDocument() {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  return {
    doc: new jsPDF(),
    autoTable,
  };
}

export function getLastAutoTableY(doc: unknown, fallback = 90) {
  return (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}
