\set ON_ERROR_STOP on
begin;
select plan(59);

select ok(exists(select 1 from information_schema.columns where table_schema='public' and table_name='pos_sale_drafts' and column_name='additional_charge_description'), 'POS draft has additive additional-charge description');
select ok(exists(select 1 from information_schema.columns where table_schema='public' and table_name='pos_sale_drafts' and column_name='other_charge_description'), 'POS draft has additive other-charge description');
select ok(to_regprocedure('public.save_pos_sale_draft_with_charge_descriptions_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric,text,text)') is not null, 'versioned description save RPC exists');
select ok(to_regprocedure('public.confirm_pos_sale_with_charge_descriptions_v1(uuid,uuid,bigint,date,jsonb)') is not null, 'versioned description confirmation RPC exists');
select ok(has_function_privilege('authenticated','public.save_pos_sale_draft_with_charge_descriptions_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric,text,text)','execute'), 'authenticated staff may save descriptions through guarded RPC');
select ok(not has_function_privilege('anon','public.save_pos_sale_draft_with_charge_descriptions_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric,text,text)','execute'), 'anonymous users cannot save descriptions');
select ok(has_function_privilege('authenticated','public.confirm_pos_sale_with_charge_descriptions_v1(uuid,uuid,bigint,date,jsonb)','execute'), 'authenticated staff may confirm through guarded description RPC');
select ok(not has_function_privilege('anon','public.confirm_pos_sale_with_charge_descriptions_v1(uuid,uuid,bigint,date,jsonb)','execute'), 'anonymous users cannot confirm through description RPC');
select ok(pg_get_functiondef('public.save_pos_sale_draft_with_charge_descriptions_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric,text,text)'::regprocedure) like '%save_pos_sale_draft_with_charges_v1%', 'description save delegates certified charge save');
select ok(pg_get_functiondef('public.confirm_pos_sale_with_charge_descriptions_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%confirm_selectable_pos_sale_v1%', 'description confirmation delegates customer-selectable atomic confirmation');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%sale_other_charge%', 'certified accounting mapping remains type-based');
select is((select count(*)::integer from pg_constraint where conrelid='public.pos_sale_drafts'::regclass and conname in ('pos_sale_drafts_additional_charge_description_check','pos_sale_drafts_other_charge_description_check')), 2, 'database keeps two format guards without historical backfill');
select ok(pg_get_functiondef('public.apply_pos_charge_descriptions_to_document_v1()'::regprocedure) like '%POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED%', 'document trigger blocks legacy confirmation without required descriptions');

insert into public.roles(name,description,permissions)
values ('admin','POS-UI-REFINEMENT-LOCAL-ONLY',jsonb_build_array(
  'pos:access','pos:create_sale','pos:drafts:create','pos:drafts:read',
  'pos:drafts:edit_own','pos:drafts:edit_any','pos:products:search',
  'pos:price_override','pos:confirm_sale','pos:reprint_documents',
  'customers:read_commercial','customers:read_credit','invoices:create'
)) on conflict(name) do update set permissions=excluded.permissions,description=excluded.description;

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('b8100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pos-ui-refinement@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active)
values ('b8100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'POS-UI-REFINEMENT-LOCAL-ONLY','pos-ui-refinement@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,active=true;
insert into public.customers(id,contact_name,email,phone,tax_id,address,city,active,status,is_wholesale,wholesale_status,wholesale_customer_type,wholesale_first_purchase_completed,commercial_version,source)
values ('b8200000-0000-4000-8000-000000000001','POS-UI-REFINEMENT-LOCAL-ONLY','pos-ui-customer@example.test','99998100','08011999123810','Tegucigalpa','Tegucigalpa',true,'active',false,'none','new',false,0,'pos');
insert into public.products(id,category_id,sku,internal_code,slug,name,brand,description,stock,reserved_stock,retail_price,wholesale_price,wholesale_min_quantity,cost_price,tax_category,tracks_inventory,status,active)
values ('b8300000-0000-4000-8000-000000000001',(select id from public.categories order by sort_order,name limit 1),'POS-UI-DESC','POS-UI-DESC','pos-ui-desc','POS-UI-REFINEMENT-LOCAL-ONLY PRODUCT','TEST','Local-only description fixture',10,0,115,100,2,50,'standard',true,'active',true);

insert into public.company_settings(id,company_name,currency,tax_rate,invoice_prefix,order_prefix,free_shipping_threshold,standard_shipping_fee,first_wholesale_minimum)
values ('b8800000-0000-4000-8000-000000000001','POS-UI-REFINEMENT-LOCAL-ONLY','HNL',0.15,'POSUI-F','POSUI',3000,120,10000);

update public.fiscal_settings set legal_name='POS UI LOCAL',rtn='08011999123810',cai='POS-UI-LOCAL-CAI',cai_authorization_date=(now() at time zone 'America/Tegucigalpa')::date-30,invoice_range_start='000-001-01-00000001',invoice_range_end='000-001-01-00000999',current_invoice_number='000-001-01-00000001',emission_deadline=(now() at time zone 'America/Tegucigalpa')::date+30,fiscal_address='Tegucigalpa',phone='99990000',email='pos-ui@example.test' where id=true;
insert into public.accounting_accounts(id,code,name,type,normal_balance,created_by)
values ('b8700000-0000-4000-8000-000000000001','POS-UI-4199','POS-UI-REFINEMENT-LOCAL-ONLY charges','revenue','credit','b8100000-0000-4000-8000-000000000001');
insert into public.accounting_mappings(mapping_type,source_key,account_id,priority,is_active,created_by)
values ('revenue','sale_other_charge','b8700000-0000-4000-8000-000000000001',100,true,'b8100000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub','b8100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','b8100000-0000-4000-8000-000000000001','role','authenticated')::text,true);

create temporary table pos_ui_state(key text primary key,value jsonb not null);
insert into pos_ui_state select 'created',public.create_selectable_pos_sale_draft_v1('b8400000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000001');
create or replace function pg_temp.save_pos_ui_descriptions(request_id uuid,additional_amount numeric,additional_description text,other_amount numeric,other_description text)
returns jsonb language sql as $$
  select public.save_pos_sale_draft_with_charge_descriptions_v1(
    request_id,(select (value->>'draftId')::uuid from pos_ui_state where key='created'),
    (select version from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),
    'b8200000-0000-4000-8000-000000000001',
    (select commercial_version from public.customers where id='b8200000-0000-4000-8000-000000000001'),
    jsonb_build_array(jsonb_build_object('productId','b8300000-0000-4000-8000-000000000001','quantity',1,'finalUnitPrice',null,'priceOverrideReason',null,'expectedProductSalesVersion',(select product_sales_version from public.products where id='b8300000-0000-4000-8000-000000000001'))),
    'store_immediate',null,null,'POS-UI-REFINEMENT-LOCAL-ONLY',0,0,
    additional_amount,other_amount,additional_description,other_description
  )
$$;

select is((pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000010',0,'Texto ignorado',0,'Otro ignorado')->>'additionalChargeDescription'),null,'amount zero accepts and clears optional description');
select ok((select additional_charge_description is null and other_charge_description is null from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'zero amounts persist no documentary noise');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000011',1,null,0,null)$$,'22023','POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED','positive additional charge requires description');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000012',0,null,1,'')$$,'22023','POS_OTHER_CHARGE_DESCRIPTION_REQUIRED','positive other charge requires description');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000013',1,'A',0,null)$$,'22023','POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED','one-character description is rejected');
select is((pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000014',1,'AB',0,null)->>'additionalChargeDescription'),'AB','two-character boundary is accepted');
select is((select additional_charge_description from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'AB','two-character value persists in draft');
select is(char_length(pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000015',1,repeat('Á',120),0,null)->>'additionalChargeDescription'),120,'120-character boundary is accepted');
select is((select char_length(additional_charge_description) from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),120,'120-character value persists exactly');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000016',1,repeat('A',121),0,null)$$,'22023','POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED','121-character value is rejected');
select is((pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000017',1,'  Instalación   premium  ',0,null)->>'additionalChargeDescription'),'Instalación premium','outer and repeated spaces are normalized');
select is((select additional_charge_description from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'Instalación premium','normalized spaces persist');
select is((pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000018',1,'Protección ñ “premium”',0,null)->>'additionalChargeDescription'),'Protección ñ “premium”','Unicode, accents, ñ and quotation marks are accepted');
select is((select additional_charge_description from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'Protección ñ “premium”','safe Unicode persists exactly');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000019',1,'A < B',0,null)$$,'22023','POS_CHARGE_DESCRIPTION_INVALID','angle brackets are rejected');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000020',1,'<script>alert(1)</script>',0,null)$$,'22023','POS_CHARGE_DESCRIPTION_INVALID','script markup is rejected');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000021',1,'<b>Instalación</b>',0,null)$$,'22023','POS_CHARGE_DESCRIPTION_INVALID','HTML markup is rejected');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000022',1,E'Instalación\nnueva',0,null)$$,'22023','POS_CHARGE_DESCRIPTION_INVALID','line breaks are rejected server-side');
select throws_ok($$select pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000023',1,E'Instalación\tnueva',0,null)$$,'22023','POS_CHARGE_DESCRIPTION_INVALID','tabs are rejected server-side');
select is((pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000024',0,'Instalación',0,'Material')->>'otherChargeDescription'),null,'descriptions are cleared when both amounts return to zero');
select ok((select additional_charge_description is null and other_charge_description is null from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'cleared descriptions persist as null');
select throws_ok($$
  select public.save_pos_sale_draft_with_charges_v1(
    'b8400000-0000-4000-8000-000000000099',
    (select (value->>'draftId')::uuid from pos_ui_state where key='created'),
    (select version from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),
    'b8200000-0000-4000-8000-000000000001',
    (select commercial_version from public.customers where id='b8200000-0000-4000-8000-000000000001'),
    jsonb_build_array(jsonb_build_object('productId','b8300000-0000-4000-8000-000000000001','quantity',1,'finalUnitPrice',null,'priceOverrideReason',null,'expectedProductSalesVersion',(select product_sales_version from public.products where id='b8300000-0000-4000-8000-000000000001'))),
    'store_immediate',null,null,'POS-UI-REFINEMENT-LOCAL-ONLY',0,0,1,0
  )
$$,'22023','POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED','legacy save RPC cannot bypass the required-description guard');

create temporary table pos_ui_mapping_snapshot as select count(*)::integer as count from public.accounting_mappings;
insert into pos_ui_state select 'saved',pg_temp.save_pos_ui_descriptions('b8400000-0000-4000-8000-000000000025',300,'Instalación',100,'Material especial');
select is((select (value->>'grandTotal')::numeric from pos_ui_state where key='saved'),515::numeric,'server total remains merchandise plus the two charge amounts');
select is((select additional_charge_description from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'Instalación','additional-charge description persists');
select is((select other_charge_description from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),'Material especial','other-charge description persists');
select ok((select payload->>'additionalChargeDescription'='Instalación' and payload->>'otherChargeDescription'='Material especial' from (select public.build_pos_sale_draft_payload_v1((select (value->>'draftId')::uuid from pos_ui_state where key='created')) payload) hydrated),'rehydration returns both descriptions');
select is((select grand_total from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),515::numeric,'draft authoritative total is unchanged by description text');
select is((select tax_amount from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),15::numeric,'description text does not alter included tax');
select is((select count(*)::integer from public.accounting_mappings),(select count from pos_ui_mapping_snapshot),'saving descriptions creates no accounting mapping');

insert into pos_ui_state select 'confirmed',public.confirm_pos_sale_with_charge_descriptions_v1(
  (select (value->>'draftId')::uuid from pos_ui_state where key='created'),
  'b8500000-0000-4000-8000-000000000001',
  (select version from public.pos_sale_drafts where id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',515)
);
select is((select value->>'status' from pos_ui_state where key='confirmed'),'confirmed','described sale confirms atomically');
select is((select (value->>'total')::numeric from pos_ui_state where key='confirmed'),515::numeric,'confirmation preserves authoritative total');
select ok((select additional_fees @> '[{"label":"Instalación","amount":300}]'::jsonb and additional_fees @> '[{"label":"Material especial","amount":100}]'::jsonb from public.orders where id=(select (value->>'order_id')::uuid from pos_ui_state where key='confirmed')),'order presents both commercial descriptions');
select ok((select additional_fees @> '[{"category":"additional_charge"}]'::jsonb and additional_fees @> '[{"category":"other_charge"}]'::jsonb from public.orders where id=(select (value->>'order_id')::uuid from pos_ui_state where key='confirmed')),'order preserves non-accounting presentation categories');
select ok((select invoice.additional_fees=orders.additional_fees from public.invoices invoice join public.orders orders on orders.id=invoice.order_id where invoice.id=(select (value->>'invoice_id')::uuid from pos_ui_state where key='confirmed')),'invoice snapshots the same described fee rows');
select is((select sum((fee->>'amount')::numeric) from public.orders orders cross join lateral jsonb_array_elements(orders.additional_fees) fee where orders.id=(select (value->>'order_id')::uuid from pos_ui_state where key='confirmed')),400::numeric,'descriptions do not duplicate charge amounts');
select is((select tax from public.invoices where id=(select (value->>'invoice_id')::uuid from pos_ui_state where key='confirmed')),15::numeric,'invoice tax remains identical after descriptions');
select is((select amount from public.payments where id=(select (value->>'payment_id')::uuid from pos_ui_state where key='confirmed')),515::numeric,'payment remains equal to the certified total');
select is((select count(*)::integer from public.orders where pos_draft_id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),1,'confirmation creates one order');
select is((select count(*)::integer from public.invoices where order_id=(select (value->>'order_id')::uuid from pos_ui_state where key='confirmed')),1,'confirmation creates one invoice');
select is((select stock from public.products where id='b8300000-0000-4000-8000-000000000001'),9,'descriptions do not change inventory semantics');

insert into pos_ui_state select 'replayed',public.confirm_pos_sale_with_charge_descriptions_v1(
  (select (value->>'draftId')::uuid from pos_ui_state where key='created'),
  'b8500000-0000-4000-8000-000000000001',
  (select (value->>'version')::bigint from pos_ui_state where key='saved'),
  (now() at time zone 'America/Tegucigalpa')::date,
  jsonb_build_object('method','cash','amount_tendered',515)
);
select is((select (value->>'replayed')::boolean from pos_ui_state where key='replayed'),true,'lost-response retry replays the confirmed sale');
select ok((select count(*)=1 from public.orders where pos_draft_id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')) and (select count(*)=1 from public.payments where order_id=(select (value->>'order_id')::uuid from pos_ui_state where key='confirmed')),'replay keeps one order and one payment');
select is((select count(*)::integer from public.audit_logs where action='pos.sale.charge_descriptions_attached' and record_id=(select (value->>'draftId')::uuid from pos_ui_state where key='created')),1,'description attachment audit is not duplicated on replay');
select is((select count(*)::integer from public.accounting_mappings),(select count from pos_ui_mapping_snapshot),'confirmation descriptions create no dynamic mapping');

select lives_ok($$
  alter table public.pos_sale_drafts disable trigger pos_sale_drafts_require_charge_descriptions;
  insert into public.pos_sale_drafts(id,owner_user_id,customer_id,customer_commercial_version,pricing_mode_snapshot,version,merchandise_gross,taxable_gross,exempt_gross,taxable_base,tax_amount,additional_charge,other_charge,grand_total,last_saved_by) values ('b8600000-0000-4000-8000-000000000001','b8100000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000001',0,'retail',1,0,0,0,0,0,1,1,2,'b8100000-0000-4000-8000-000000000001');
  alter table public.pos_sale_drafts enable trigger pos_sale_drafts_require_charge_descriptions;
$$,'pre-migration historical charge rows without descriptions remain readable');
select ok((select payload->>'additionalChargeDescription' is null and payload->>'otherChargeDescription' is null from (select public.build_pos_sale_draft_payload_v1('b8600000-0000-4000-8000-000000000001') payload) legacy),'historical payloads expose nullable descriptions for generic-label fallback');

select * from finish();
rollback;
\echo 'POS charge descriptions and professional presentation contract: OK'
