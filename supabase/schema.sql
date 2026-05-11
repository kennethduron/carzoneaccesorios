-- Schema entrypoint for quick review.
-- Apply the versioned files in supabase/migrations in filename order.

\i ./migrations/202605090001_initial_schema.sql
\i ./migrations/202605090002_rls_policies.sql
\i ./migrations/202605090003_storage.sql
\i ./migrations/202605090004_products_step5.sql
\i ./migrations/202605090005_wholesale_codes_step6.sql
\i ./migrations/202605090006_orders_step15.sql
\i ./migrations/202605090007_invoices_step16.sql
\i ./migrations/202605090008_crm_step18.sql
\i ./migrations/202605090009_security_step19.sql
\i ./migrations/202605090010_optimization_step20.sql
\i ./migrations/202605090011_payments_transfer_step2.sql
\i ./migrations/202605090012_customer_phone_step5.sql
\i ./migrations/202605090013_vehicle_filters_step9.sql
\i ./migrations/202605100001_api_grants.sql
\i ./migrations/202605100002_fiscal_settings.sql
\i ./migrations/202605100003_accountant_permissions.sql
\i ./migrations/202605100004_invoice_creation_permission.sql
\i ./migrations/202605100005_fiscal_invoice_number_rpc.sql
\i ./migrations/202605100006_accountant_customer_read.sql
\i ./migrations/202605100007_public_checkout_orders.sql
\i ./migrations/202605100008_create_checkout_order_rpc.sql
\i ./migrations/202605100009_confirmed_order_inventory.sql
\i ./migrations/202605100010_fiscal_invoice_rpc.sql
\i ./migrations/202605100011_guest_checkout_invoice_corrections.sql
\i ./migrations/202605100012_fiscal_audit_controls.sql
\i ./migrations/202605100013_fix_wholesale_code_read_grants.sql
\i ./migrations/202605100014_error_logs.sql
\i ./migrations/202605100015_stability_grants.sql
