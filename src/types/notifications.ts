export type NotificationSettings = {
  notification_emails: string;
  notify_new_orders: boolean;
  notify_payment_confirmed: boolean;
  notify_wholesale_requests: boolean;
  notify_transfer_receipt_uploaded: boolean;
  notify_customer_account_created: boolean;
  notify_low_stock: boolean;
  send_daily_activity_summary: boolean;
  send_weekly_sales_summary: boolean;
};

export type NotificationLogStatus = "sent" | "failed" | "skipped";
