export type NotificationSettings = {
  notification_emails: string;
  notify_new_orders: boolean;
  notify_payment_confirmed: boolean;
  notify_wholesale_requests: boolean;
};

export type NotificationLogStatus = "sent" | "failed" | "skipped";
