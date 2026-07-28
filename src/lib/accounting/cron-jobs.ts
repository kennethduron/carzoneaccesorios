import "server-only";

import { processDueAccountingOutboxesV2 } from "@/services/accounting/accounting-outbox-v2";

export async function processAccountingOutboxV2Job() {
  const results = await processDueAccountingOutboxesV2(20);

  return {
    claimed: results.filter((result) => result.claimed).length,
    completed: results.filter((result) => result.outboxStatus === "completed").length,
    pendingMapping: results.filter((result) => result.outboxStatus === "pending_mapping").length,
    pendingData: results.filter((result) => result.outboxStatus === "pending_data").length,
    failed: results.filter((result) => !result.ok && result.outboxStatus === "failed").length,
    cancelled: results.filter((result) => result.outboxStatus === "cancelled").length,
  };
}
