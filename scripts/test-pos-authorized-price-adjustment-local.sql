\set ON_ERROR_STOP on
begin;
-- Disposable fixtures and configuration are rolled back together.
do $$
declare
  actor uuid; seller uuid; administrator uuid; customer uuid := gen_random_uuid();
  product uuid := gen_random_uuid(); role_name text; method text;
  draft jsonb; saved jsonb; result jsonb; request jsonb; request_id uuid;
  price numeric; cv integer; pv bigint; item record; qty integer;
  outbox record; event record;
begin
  foreach role_name in array array['technical_owner','business_owner','admin','vendedor'] loop
    actor := gen_random_uuid();
    insert into auth.users(id,email) values(actor,actor::text||'@pos-hotfix.invalid');
    update public.users set role_id=(select id from public.roles where name=role_name),active=true,full_name='POS hotfix '||role_name where id=actor;
    if role_name='admin' then administrator:=actor; end if;
    if role_name='vendedor' then seller:=actor; end if;
  end loop;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  insert into public.company_settings(company_name,currency,tax_rate,invoice_prefix,order_prefix,free_shipping_threshold,standard_shipping_fee,first_wholesale_minimum)
    values('LOCAL HOTFIX','HNL',0.15,'LOCAL','LOCAL',3000,120,10000);
  insert into public.customers(id,contact_name,phone,active,status,address,city)
    values(customer,'POS hotfix local','99999999',true,'active','Local','Tegucigalpa');
  insert into public.customer_credit_accounts(customer_id,is_credit_enabled,credit_limit,terms_days,status,activated_by)
    values(customer,true,1000000,30,'active',administrator);
  insert into public.products(id,sku,slug,name,brand,category_id,retail_price,wholesale_price,cost_price,stock,active,status,tax_category)
    values(product,product::text,product::text,'POS hotfix 5500','LOCAL',
      (select id from public.categories limit 1),5500,5200,1000,500,true,'active','standard');
  select commercial_version into cv from public.customers where id=customer;
  select product_sales_version into pv from public.products where id=product;
  update public.fiscal_settings set legal_name='LOCAL ONLY',rtn='08011999123456',cai='LOCAL-HOTFIX',
    cai_authorization_date=current_date-1,invoice_range_start='000-001-01-00000001',
    invoice_range_end='000-001-01-99999999',current_invoice_number='000-001-01-00010000',
    emission_deadline=current_date+30,fiscal_address='Local',phone='99999999',email='local@example.invalid';
  update public.accounting_feature_flags set state='enabled',cutover_at=now()-interval '1 day'
    where key in ('sales_draft_v2','cogs_draft_v2');
  insert into public.accounting_accounts(code,name,type,normal_balance,created_by)
    values('POS-HOTFIX-LOCAL','LOCAL card','asset','debit',administrator);
  insert into public.accounting_mappings(mapping_type,source_key,account_id,priority,is_active,effective_from,created_by)
    select 'payment_method','card',id,1,true,current_date,administrator from public.accounting_accounts
      where code='POS-HOTFIX-LOCAL';
  perform public.create_sales_commission_rule_v1(gen_random_uuid(),seller,'PERCENTAGE',5,current_date,'POS hotfix local commission');

  for actor,role_name in select u.id,r.name from public.users u join public.roles r on r.id=u.role_id where u.email like '%@pos-hotfix.invalid' loop
    perform set_config('request.jwt.claim.sub',actor::text,true);
    assert public.pos_permission_allowed('pos:price_override')=(role_name<>'vendedor'), 'RBAC mismatch';
    foreach method in array array['cash','bank_transfer','card','commercial_credit'] loop
      draft:=public.create_selectable_pos_sale_draft_v1(gen_random_uuid(),customer);
      if role_name='vendedor' then
        begin
          perform public.save_pos_sale_draft_with_charge_descriptions_v1(gen_random_uuid(),(draft->>'draftId')::uuid,(draft->>'version')::bigint,customer,cv,
            jsonb_build_array(jsonb_build_object('productId',product,'quantity',3,'finalUnitPrice',5000,'priceOverrideReason','Local authorization','expectedProductSalesVersion',pv)));
          raise exception 'SELLER_BYPASS';
        exception when insufficient_privilege then null; end;
      end if;
      saved:=public.save_pos_sale_draft_with_charge_descriptions_v1(gen_random_uuid(),(draft->>'draftId')::uuid,(draft->>'version')::bigint,customer,cv,
        jsonb_build_array(jsonb_build_object('productId',product,'quantity',3,'finalUnitPrice',case when role_name='vendedor' then null else 5000 end,'priceOverrideReason','Local authorization','expectedProductSalesVersion',pv)));
      request_id:=null;
      if role_name='vendedor' then
        request:=public.create_pos_price_request_v1(gen_random_uuid(),(saved->>'draftId')::uuid,(saved->>'version')::bigint,(saved->'items'->0->>'itemId')::uuid,5000,'Local requested authorization');
        request_id:=(request->>'requestId')::uuid;
        perform set_config('request.jwt.claim.sub',administrator::text,true);
        perform public.decide_pos_price_request_v1(request_id,'approve','Local approved authorization');
        perform set_config('request.jwt.claim.sub',actor::text,true);
      else
        assert (saved->'items'->0->>'finalUnitPrice')::numeric=5000;
        assert (saved->>'grandTotal')::numeric=15000;
        assert (saved->>'taxableBase')::numeric=13043.48;
        assert (saved->>'taxAmount')::numeric=1956.52;
      end if;
      result:=public.confirm_pos_sale_with_charge_descriptions_v1(
        (saved->>'draftId')::uuid,gen_random_uuid(),(saved->>'version')::bigint,current_date,
        jsonb_build_object('method',method,'amount_tendered',15000,'verified',true,'reference','LOCAL',
          'price_override_request_ids',case when request_id is null then '[]'::jsonb else jsonb_build_array(request_id) end));
      select * into item from public.order_items where order_id=(result->>'order_id')::uuid;
      assert item.unit_price=5000 and item.quantity=3 and item.line_total=15000, 'order effective price';
      assert item.taxable_base_snapshot=13043.48 and item.tax_amount_snapshot=1956.52, 'included ISV';
      assert item.unit_cost_snapshot=1000 and item.total_cost_snapshot=3000, 'cost unchanged';
      assert item.price_overridden_by is not null and item.price_override_reason is not null, 'audit retained';
      if role_name<>'vendedor' then assert item.price_overridden_by=actor, 'direct elevated actor retained'; end if;
      assert (select total=15000 and subtotal=13043.48 and tax=1956.52 from public.invoices where id=(result->>'invoice_id')::uuid), 'invoice totals';
      assert (select unit_price=5000 and quantity=3 and line_total=15000 from public.invoice_items where invoice_id=(result->>'invoice_id')::uuid), 'invoice snapshot';
      if method='commercial_credit' then
        assert (select original_amount=15000 and balance_due=15000 from public.accounts_receivable where order_id=(result->>'order_id')::uuid), 'CxC';
      else
        assert (select amount=15000 from public.payments where order_id=(result->>'order_id')::uuid), 'payment';
      end if;
      if role_name='vendedor' then
        assert (select eligible_base_amount=13043.48 and potential_amount=652.17 from public.sales_commission_entries where order_id=(result->>'order_id')::uuid), 'commission final net merchandise';
        assert (select status='consumed' from public.pos_price_requests where id=request_id), 'approval consumed';
      else
        assert not exists(select 1 from public.sales_commission_entries where order_id=(result->>'order_id')::uuid), 'no invented commission';
      end if;
      assert (select retail_price=5500 and wholesale_price=5200 and cost_price=1000 from public.products where id=product), 'catalog untouched';
      perform set_config('request.jwt.claim.sub',administrator::text,true);
      for outbox in select * from public.accounting_outbox_v2 where source_type='order' and source_id=(result->>'order_id')::uuid and topic='sales.recognized' loop
        perform public.process_accounting_outbox_v2(outbox.id,'pos-hotfix-local',true);
      end loop;
      select * into strict event from public.financial_events where source_type='order' and source_id=result->>'order_id' and event_purpose='sale_recognized';
      assert (event.source_snapshot->'financials'->>'total_final')::numeric=15000, 'accounting total';
      assert (event.source_snapshot->'financials'->>'fiscal_subtotal')::numeric=13043.48, 'accounting revenue';
      assert (event.source_snapshot->'financials'->>'included_tax_total')::numeric=1956.52, 'accounting included ISV';
      for outbox in select b.* from public.accounting_outbox_v2 b join public.inventory_movements m on m.id=b.source_id
        where b.source_type='inventory_movement' and m.reference_id=(result->>'order_id')::uuid loop
        perform public.process_accounting_outbox_v2(outbox.id,'pos-hotfix-local',true);
      end loop;
      assert exists(select 1 from public.financial_events f join public.inventory_movements m on m.id::text=f.source_id
        where f.source_type='inventory_movement' and m.reference_id=(result->>'order_id')::uuid
          and (f.source_snapshot->>'total_cost_snapshot')::numeric=3000), 'COGS event remains cost-based';
      perform set_config('request.jwt.claim.sub',actor::text,true);
      raise notice 'PASS role=% method=% order/invoice/payment/CxC/commission/cost total=15000',role_name,method;
    end loop;
  end loop;
  perform set_config('request.jwt.claim.sub',administrator::text,true);
  draft:=public.create_selectable_pos_sale_draft_v1(gen_random_uuid(),customer);
  foreach price in array array[5000,5500,6000,5000.129] loop
    foreach qty in array array[1,3,2] loop
      saved:=public.save_pos_sale_draft_with_charge_descriptions_v1(gen_random_uuid(),(draft->>'draftId')::uuid,(draft->>'version')::bigint,customer,cv,
        jsonb_build_array(jsonb_build_object('productId',product,'quantity',qty,'finalUnitPrice',price,'priceOverrideReason','Local authorization','expectedProductSalesVersion',pv)));
      assert (saved->'items'->0->>'finalUnitPrice')::numeric=round(price,2), 'canonical rounding';
      assert (saved->>'grandTotal')::numeric=round(price,2)*qty, 'quantity effective price';
      assert (saved->'items'->0->>'priceOverridden')::boolean=(price<>5500), 'same price removes override';
      draft:=saved;
    end loop;
  end loop;
  foreach price in array array[0,-1,999,1000000000000000] loop
    begin
      perform public.save_pos_sale_draft_with_charge_descriptions_v1(gen_random_uuid(),(draft->>'draftId')::uuid,(draft->>'version')::bigint,customer,cv,
        jsonb_build_array(jsonb_build_object('productId',product,'quantity',3,'finalUnitPrice',price,'priceOverrideReason','Local authorization','expectedProductSalesVersion',pv)));
      raise exception 'INVALID_PRICE_ACCEPTED %',price;
    exception when invalid_parameter_value or numeric_value_out_of_range then null; end;
  end loop;
  raise notice 'PASS lower/same/higher/rounding/quantity/zero/negative/cost-floor/overflow';
end $$;
rollback;

