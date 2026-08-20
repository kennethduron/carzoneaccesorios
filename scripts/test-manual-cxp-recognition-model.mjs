import assert from "node:assert/strict";

const allowedRoles = new Set(["technical_owner", "business_owner", "admin", "contadora"]);

class RecognitionModel {
  constructor({ total = 100, sourceBacked = false, periodClosed = false } = {}) {
    this.total = total;
    this.sourceBacked = sourceBacked;
    this.periodClosed = periodClosed;
    this.state = sourceBacked ? "source_backed" : "pending_accounting_recognition";
    this.eventCount = sourceBacked ? 0 : 1;
    this.journalCount = 0;
    this.auditCount = 0;
    this.lock = Promise.resolve();
  }
  async complete(input) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (!input.authenticated || !allowedRoles.has(input.role) || !input.payablesManage || !input.accountingManage) throw new Error("DENIED");
      if (this.sourceBacked) throw new Error("SOURCE_BACKED");
      if (this.periodClosed) throw new Error("PERIOD_CLOSED");
      if (!input.account.active || input.account.normalBalance !== "debit" || !["asset", "cost", "expense"].includes(input.account.type)) throw new Error("ACCOUNT_INVALID");
      if (input.subtotal < 0 || input.tax < 0 || input.discount < 0 || Math.round((input.subtotal + input.tax - input.discount) * 100) !== Math.round(this.total * 100)) throw new Error("BREAKDOWN_INVALID");
      if (this.journalCount > 0) return { replayed: true, state: this.state };
      this.journalCount += 1;
      this.auditCount += 1;
      this.state = "draft_pending_publication";
      return { replayed: false, state: this.state };
    } finally { release(); }
  }
  publish() { if (this.journalCount !== 1) throw new Error("NO_DRAFT"); this.state = "recognized"; }
  paymentEligible() { return this.state === "recognized" || this.state === "source_backed"; }
}

const valid = { authenticated: true, role: "contadora", payablesManage: true, accountingManage: true, account: { active: true, normalBalance: "debit", type: "expense" }, subtotal: 100, tax: 0, discount: 0 };

const completeAtCreation = new RecognitionModel();
assert.equal((await completeAtCreation.complete(valid)).state, "draft_pending_publication");
assert.equal(completeAtCreation.paymentEligible(), false);
completeAtCreation.publish();
assert.equal(completeAtCreation.paymentEligible(), true);

const pendingThenComplete = new RecognitionModel({ total: 115 });
assert.equal(pendingThenComplete.state, "pending_accounting_recognition");
assert.equal(pendingThenComplete.paymentEligible(), false);
await pendingThenComplete.complete({ ...valid, subtotal: 100, tax: 15 });
assert.equal(pendingThenComplete.state, "draft_pending_publication");
pendingThenComplete.publish();
assert.equal(pendingThenComplete.state, "recognized");

for (const role of allowedRoles) {
  const model = new RecognitionModel();
  await model.complete({ ...valid, role });
  assert.equal(model.journalCount, 1, `${role} must be allowed`);
}
for (const role of ["vendedor", "bodega", "soporte", "cliente"]) {
  await assert.rejects(() => new RecognitionModel().complete({ ...valid, role }), /DENIED/);
}
await assert.rejects(() => new RecognitionModel().complete({ ...valid, authenticated: false }), /DENIED/);
await assert.rejects(() => new RecognitionModel().complete({ ...valid, account: { active: false, normalBalance: "debit", type: "expense" } }), /ACCOUNT_INVALID/);
await assert.rejects(() => new RecognitionModel().complete({ ...valid, account: { active: true, normalBalance: "credit", type: "liability" } }), /ACCOUNT_INVALID/);
await assert.rejects(() => new RecognitionModel({ periodClosed: true }).complete(valid), /PERIOD_CLOSED/);
await assert.rejects(() => new RecognitionModel().complete({ ...valid, subtotal: 99 }), /BREAKDOWN_INVALID/);
await assert.rejects(() => new RecognitionModel({ sourceBacked: true }).complete(valid), /SOURCE_BACKED/);

const concurrent = new RecognitionModel();
const [first, second] = await Promise.all([concurrent.complete(valid), concurrent.complete(valid)]);
assert.equal([first, second].filter((result) => !result.replayed).length, 1);
assert.equal(concurrent.journalCount, 1);
assert.equal(concurrent.auditCount, 1);
assert.equal((await concurrent.complete(valid)).replayed, true);
assert.equal(concurrent.journalCount, 1);

console.log("manual CxP recognition synthetic model: PASS");
