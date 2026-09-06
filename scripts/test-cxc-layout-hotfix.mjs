import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../src/components/admin/accounts-receivable-manager.tsx", import.meta.url),
  "utf8",
);

const customerFixtures = [
  "ACCES-CAR",
  "Inversiones Contreras",
  "AUTOLOTE Y TALLER AUTOMOTRIZ POLANCO",
  "POLARIZADOS Y LUJOS DE CARRO Y ACCESORIOS DEL NORTE",
  "POLARIZADOS JEHOVÁ PROVEERÁ",
];

assert.equal(customerFixtures.length, 5);
assert.match(source, /if \(selectedId === null\) return null;/, "closing detail must clear selection");
assert.match(
  source,
  /selected \? "xl:grid-cols-\[minmax\(0,1fr\)_clamp\(320px,26vw,360px\)\]" : "grid-cols-1"/,
  "the detail grid track must only exist while an account is selected",
);
assert.match(
  source,
  /<strong className="block min-w-0 truncate" title=\{row\.customer_name\}>/,
  "customer text must be a bounded block with its full value available",
);
assert.match(
  source,
  /<span className="block min-w-0 truncate" title=\{row\.order_number/,
  "order identifiers must remain inside their grid track",
);
assert.match(source, /aria-label="Cerrar detalle de cuenta"/);
assert.match(source, /document\.getElementById\(`cxc-detail-\$\{selected\.id\}`\)\?\.focus\(\)/, "desktop close must restore focus");
assert.match(source, /returnFocusId=\{`cxc-detail-\$\{selected\.id\}`\}/, "mobile close must restore focus");
assert.match(source, /id=\{`cxc-detail-\$\{row\.id\}`\}/, "each detail trigger needs a stable focus target");
assert.match(source, /closeMobileDetail = \(\) => \{ setDetailMobile\(false\); setSelectedId\(null\); \}/, "mobile close must clear its selected state");

const desktopRow = source.match(/<article role="row"[\s\S]*?<\/article>/)?.[0] ?? "";
assert.ok(desktopRow, "the receivable row must exist");
assert.equal((desktopRow.match(/role="cell"/g) ?? []).length, 8, "all eight visible columns remain present");
assert.equal((desktopRow.match(/min-w-0/g) ?? []).length >= 8, true, "every column must be shrinkable and bounded");
assert.equal((desktopRow.match(/overflow-hidden/g) ?? []).length >= 7, true, "cell content must not paint into adjacent tracks");

console.log("CxC table and detail layout hotfix contracts passed.");
