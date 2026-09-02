\set ON_ERROR_STOP on

begin;

do $$
declare
  seller constant uuid := '21000000-0000-4000-8000-000000000001';
  seller_two constant uuid := '21000000-0000-4000-8000-000000000002';
  administrator constant uuid := '21000000-0000-4000-8000-000000000003';
  customer constant uuid := '22000000-0000-4000-8000-000000000001';
  product constant uuid := '23000000-0000-4000-8000-000000000001';
  draft constant uuid := '24000000-0000-4000-8000-000000000001';
  draft_item constant uuid := '25000000-0000-4000-8000-000000000001';
  created_request_id uuid;
  payload jsonb;
begin
  insert into auth.users(id,email) values
    (seller,'phase2-seller-1@example.invalid'),
    (seller_two,'phase2-seller-2@example.invalid'),
    (administrator,'phase2-admin@example.invalid');
  update public.users set
    role_id=case when id=administrator then (select id from public.roles where name='admin')
      else (select id from public.roles where name='vendedor') end,
    full_name=case id when seller then 'Vendedor Uno' when seller_two then 'Vendedor Dos' else 'Administrador' end,
    active=true
  where id in (seller,seller_two,administrator);
  insert into public.customers(id,contact_name,phone,email,active,status)
    values(customer,'Cliente Phase 2','99999999','phase2-customer@example.invalid',true,'active');
  insert into public.products(id,sku,slug,name,brand,category_id,retail_price,wholesale_price,cost_price,stock,active,status)
    values(product,'PH2-001','phase2-product','Producto Phase 2','Car Zone',
      (select id from public.categories where slug='exterior'),100,90,50,20,true,'active');
  insert into public.pos_sale_drafts(
    id,owner_user_id,customer_id,customer_commercial_version,pricing_mode_snapshot,
    version,last_saved_by,merchandise_gross,taxable_gross,taxable_base,tax_amount,grand_total
  ) values(
    draft,seller,customer,(select commercial_version from public.customers where id=customer),'retail',
    1,seller,100,100,86.96,13.04,100
  );
  insert into public.pos_sale_draft_items(
    id,draft_id,product_id,product_sales_version,sku_snapshot,product_name_snapshot,
    brand_snapshot,pricing_source,base_unit_price,final_unit_price,quantity,
    tax_category_snapshot,tax_rate_snapshot,line_merchandise_gross,line_taxable_base,
    line_tax_amount,line_exempt_amount,available_stock_snapshot,stock_observed_at,
    stock_status,validation_status,cost_floor_validated,cost_validated_at,line_position
  ) select draft_item,draft,product,product_sales_version,sku,name,brand,'retail',100,100,1,
      tax_category,0.15,100,86.96,13.04,0,20,now(),'available','valid',true,now(),1
    from public.products where id=product;

  perform set_config('request.jwt.claim.sub',seller::text,true);
  payload := public.create_pos_price_request_v1(
    '26000000-0000-4000-8000-000000000001',draft,1,draft_item,80,
    'Cliente frecuente; precio excepcional para cerrar esta venta.'
  );
  created_request_id := (payload->>'requestId')::uuid;
  if payload->>'status'<>'pending' or payload ? 'costPrice' or payload ? 'margin' then
    raise exception 'PHASE2_REQUEST_PAYLOAD_FAILED';
  end if;
  payload := public.create_pos_price_request_v1(
    '26000000-0000-4000-8000-000000000001',draft,1,draft_item,80,
    'Cliente frecuente; precio excepcional para cerrar esta venta.'
  );
  if payload->>'idempotentReplay'<>'true' then raise exception 'PHASE2_IDEMPOTENCY_FAILED'; end if;

  update public.users set role_id=(select id from public.roles where name='admin') where id=seller;
  begin
    perform public.decide_pos_price_request_v1(created_request_id,'approve',null);
    raise exception 'PHASE2_SELF_APPROVAL_WAS_ALLOWED';
  exception when sqlstate '42501' then null;
  end;
  update public.users set role_id=(select id from public.roles where name='vendedor') where id=seller;

  perform set_config('request.jwt.claim.sub',administrator::text,true);
  payload := public.decide_pos_price_request_v1(created_request_id,'approve',null);
  if payload->>'status'<>'approved'
    or abs(extract(epoch from ((payload->>'expiresAt')::timestamptz-now()))-1800)>5 then
    raise exception 'PHASE2_APPROVAL_EXPIRY_FAILED';
  end if;
  begin
    perform public.decide_pos_price_request_v1(created_request_id,'reject','Decision concurrente de prueba.');
    raise exception 'PHASE2_DUPLICATE_DECISION_WAS_ALLOWED';
  exception when sqlstate 'PT409' then null;
  end;

  perform set_config('request.jwt.claim.sub',seller::text,true);
  insert into public.pos_sale_confirmation_context(
    backend_pid,transaction_id,actor_id,draft_id,request_key
  ) values(
    pg_backend_pid(),txid_current(),seller,draft,'26000000-0000-4000-8000-000000000099'
  );
  insert into public.orders(
    id,order_number,customer_id,customer_name,phone,customer_phone,delivery_address,
    payment_method,subtotal,tax,total,status,source,channel,created_by,confirmed_by,pos_draft_id
  ) values(
    '27000000-0000-4000-8000-000000000001','PH2-ORDER-1',customer,'Cliente Phase 2',
    '99999999','99999999','Tienda','cash',80,0,80,'confirmado','pos','store',seller,seller,draft
  );
  if not exists(
    select 1 from public.pos_price_requests request
    join public.orders sale on sale.pos_draft_id=request.draft_id
    where request.id=created_request_id and request.seller_user_id=auth.uid()
      and request.product_id=product and request.quantity=1 and request.requested_unit_price=80
      and request.status='approved' and request.expires_at>now()
      and sale.id='27000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'PHASE2_PRECONSUMPTION_BINDING_FAILED actor=%, role=%, request=%',
      auth.uid(),public.current_actor_role(),(select to_jsonb(r) from public.pos_price_requests r where r.id=created_request_id);
  end if;
  insert into public.order_items(
    order_id,product_id,sku,product_name,quantity,applied_price_mode,unit_price,line_total,
    retail_price_snapshot,wholesale_price_snapshot,price_overridden_by
  ) values(
    '27000000-0000-4000-8000-000000000001',product,'PH2-001','Producto Phase 2',1,
    'retail',80,80,100,90,seller
  );
  if (select status from public.pos_price_requests where id=created_request_id)<>'consumed' then
    raise exception 'PHASE2_CONSUMPTION_FAILED';
  end if;
  begin
    insert into public.order_items(
      order_id,product_id,sku,product_name,quantity,applied_price_mode,unit_price,line_total,
      retail_price_snapshot,wholesale_price_snapshot,price_overridden_by
    ) values(
      '27000000-0000-4000-8000-000000000001',product,'PH2-001-R','Producto Phase 2',1,
      'retail',80,80,100,90,seller
    );
    raise exception 'PHASE2_REPLAY_WAS_ALLOWED';
  exception when sqlstate '42501' then null;
  end;

  if (select count(*) from public.pos_price_request_events event where event.request_id=created_request_id)<3 then
    raise exception 'PHASE2_EVENT_HISTORY_FAILED';
  end if;
  begin
    update public.pos_price_request_events event set reason='mutated' where event.request_id=created_request_id;
    raise exception 'PHASE2_EVENT_MUTATION_WAS_ALLOWED';
  exception when sqlstate '42501' then null;
  end;

  perform set_config('request.jwt.claim.sub',seller_two::text,true);
  payload := public.list_my_pos_sales_v1(current_date-1,current_date+1,null,null,null,20,0);
  if (payload->>'total')::integer<>0 then raise exception 'PHASE2_OTHER_SELLER_LEAK'; end if;
  perform set_config('request.jwt.claim.sub',seller::text,true);
  payload := public.list_my_pos_sales_v1(current_date-1,current_date+1,null,null,null,20,0);
  if (payload->>'total')::integer<>1 then raise exception 'PHASE2_OWN_SALES_SCOPE_FAILED'; end if;

  raise notice 'Sales commercial Phase 2 local database contracts: PASS';
end;
$$;

rollback;
