import "server-only";

import { queuePendingReservationReviewEmails } from "@/lib/notifications/cron-jobs";

// Backward-compatible name for older imports. The implementation now queues
// emails instead of sending directly to the provider.
export async function deliverPendingReservationReviewEmails() {
  return queuePendingReservationReviewEmails();
}
