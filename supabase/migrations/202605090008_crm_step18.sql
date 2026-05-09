alter table public.customers
  add column if not exists lead_status text not null default 'cliente'
    check (lead_status in ('prospecto', 'contactado', 'calificado', 'cliente', 'perdido')),
  add column if not exists source text,
  add column if not exists estimated_value numeric(12, 2) not null default 0 check (estimated_value >= 0),
  add column if not exists monthly_amount numeric(12, 2) not null default 0 check (monthly_amount >= 0);

alter table public.crm_followups
  add column if not exists interaction_type text not null default 'seguimiento'
    check (interaction_type in ('seguimiento', 'llamada', 'nota', 'reunion', 'prospecto')),
  add column if not exists priority text not null default 'media'
    check (priority in ('baja', 'media', 'alta', 'urgente')),
  add column if not exists next_action text,
  add column if not exists notes text,
  add column if not exists estimated_value numeric(12, 2) not null default 0 check (estimated_value >= 0),
  add column if not exists monthly_amount numeric(12, 2) not null default 0 check (monthly_amount >= 0);

create index if not exists customers_lead_status_idx on public.customers(lead_status);
create index if not exists customers_estimated_value_idx on public.customers(estimated_value);
create index if not exists crm_followups_status_priority_idx on public.crm_followups(status, priority);
create index if not exists crm_followups_interaction_type_idx on public.crm_followups(interaction_type);
