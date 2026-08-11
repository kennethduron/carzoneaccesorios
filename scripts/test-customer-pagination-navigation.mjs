import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildCustomerPaginationHref,
  customerCriteriaChanged,
} from "../src/lib/customers/customer-pagination.ts";

const paginationInput = {
  basePath: "/admin/clientes",
  query: "",
  filter: "all",
};

assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 1 }), "/admin/clientes?filter=all");
assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 2 }), "/admin/clientes?filter=all&page=2");
assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 3 }), "/admin/clientes?filter=all&page=3");
assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 4 }), "/admin/clientes?filter=all&page=4");

assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 3 }), "/admin/clientes?filter=all&page=3", "previous from page 4 preserves the filter");
assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 2 }), "/admin/clientes?filter=all&page=2", "previous from page 3 preserves the filter");
assert.equal(buildCustomerPaginationHref({ ...paginationInput, page: 1 }), "/admin/clientes?filter=all", "previous from page 2 returns to the canonical first-page URL");

assert.equal(customerCriteriaChanged({ query: "", filter: "all" }, { query: "", filter: "all" }), false, "same filter and empty search do not reset pagination");
assert.equal(customerCriteriaChanged({ query: "rapalo", filter: "all" }, { query: "rapalo", filter: "all" }), false, "rerendering the same search does not reset pagination");
assert.equal(customerCriteriaChanged({ query: "polarizados", filter: "all" }, { query: "rapalo", filter: "all" }), true, "a real search change resets pagination");
assert.equal(customerCriteriaChanged({ query: "", filter: "wholesale" }, { query: "", filter: "all" }), true, "a real filter change resets pagination");

assert.equal(
  buildCustomerPaginationHref({ basePath: "/admin/clientes", query: "rapalo", filter: "wholesale", page: 2 }),
  "/admin/clientes?q=rapalo&filter=wholesale&page=2",
  "pagination preserves active search and filter criteria",
);
assert.equal(
  buildCustomerPaginationHref({ basePath: "/admin/clientes", query: "all", filter: "clients", page: 2 }),
  "/admin/clientes?q=all&page=2",
  "the literal search term all is not discarded",
);

const [managerSource, paginationSource] = await Promise.all([
  readFile(new URL("../src/components/admin/crm-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pagination-controls.tsx", import.meta.url), "utf8"),
]);

assert.match(managerSource, /customerCriteriaChanged\(/, "the URL synchronization effect distinguishes real criteria changes");
assert.match(managerSource, /buildCustomerPaginationHref/, "customer pagination uses the customer-specific URL contract");
assert.match(managerSource, /params\.delete\("page"\)/, "real search or filter changes continue resetting to page one");
assert.match(paginationSource, /aria-disabled=\{page <= 1\}/, "previous is disabled on page one");
assert.match(paginationSource, /aria-disabled=\{page >= totalPages\}/, "next is disabled on the last page");
assert.match(paginationSource, /buildHref\(page - 1\)/, "previous navigation remains wired");
assert.match(paginationSource, /buildHref\(page \+ 1\)/, "next navigation remains wired");

console.log("customer pagination URL, reset and multipage regression tests: PASS");
