-- Allow public contact forms to preserve their source in CRM followups.

alter table public.crm_followups
  drop constraint if exists crm_followups_interaction_type_check;

alter table public.crm_followups
  add constraint crm_followups_interaction_type_check
  check (
    interaction_type in (
      'seguimiento',
      'llamada',
      'nota',
      'reunion',
      'prospecto',
      'contacto_general',
      'solicitud_mayorista'
    )
  );
