const round = (value) => Math.round(value * 100) / 100;

function total({ subtotal, tax, shipping = 0, cod = 0, small = 0, discounts = 0, other = 0 }) {
  return round(subtotal + tax + shipping + cod + small + other - discounts);
}

const cases = [
  {
    name: "pedido con envio y contra entrega",
    input: { subtotal: 510, tax: 76.5, shipping: 50, cod: 25, small: 20 },
    expected: 681.5,
  },
  {
    name: "pedido sin envio",
    input: { subtotal: 3000, tax: 450, shipping: 0 },
    expected: 3450,
  },
  {
    name: "transferencia sin contra entrega",
    input: { subtotal: 1000, tax: 150, shipping: 120, cod: 0 },
    expected: 1270,
  },
  {
    name: "pedido menor al minimo",
    input: { subtotal: 250, tax: 37.5, shipping: 120, small: 20 },
    expected: 427.5,
  },
  {
    name: "pedido mayor al minimo",
    input: { subtotal: 5000, tax: 750, shipping: 0, small: 0 },
    expected: 5750,
  },
];

const failures = cases
  .map((item) => ({ ...item, actual: total(item.input) }))
  .filter((item) => item.actual !== item.expected);

if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, cases: cases.map((item) => item.name) }, null, 2));
