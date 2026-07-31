import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_LOCAL_URL;
const serviceKey = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error('Set SUPABASE_LOCAL_URL and SUPABASE_LOCAL_SERVICE_ROLE_KEY from `supabase status`.');
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const requestKey = randomUUID();
const productId = randomUUID();
const recoveryToken = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
const email = `checkout-v4-concurrency-${requestKey}@example.test`;
const cartItems = [{ product_id: productId, variant_id: null, quantity: 2 }];
const customerData = {
  name: 'Checkout V4 Concurrente',
  email,
  phone: '99990009',
  rtn: null,
  email_updates_opt_in: true,
  bank_reference: 'V4-CONCURRENT-001',
};
const deliveryData = {
  country: 'Honduras',
  country_code: 'HN',
  department: 'Francisco Morazan',
  city: 'Tegucigalpa',
  address: 'Fixture local de concurrencia',
  mode: 'home_delivery',
};

function assert(condition, message, details) {
  if (!condition) throw new Error(`${message}${details ? `: ${JSON.stringify(details)}` : ''}`);
}

const { data: category, error: categoryError } = await supabase
  .from('categories')
  .select('id')
  .order('sort_order')
  .limit(1)
  .single();
assert(!categoryError && category?.id, 'A local product category is required', categoryError);

const { error: productError } = await supabase.from('products').insert({
  id: productId,
  category_id: category.id,
  sku: `V4-CONCURRENT-${productId.slice(0, 8)}`,
  internal_code: `V4C-${productId.slice(0, 8)}`,
  slug: `checkout-v4-concurrent-${productId}`,
  name: 'Checkout V4 Concurrente',
  brand: 'TEST',
  description: 'Fixture local de concurrencia',
  stock: 20,
  reserved_stock: 0,
  retail_price: 230,
  wholesale_price: 180,
  wholesale_min_quantity: 2,
  cost_price: 90,
  tax_category: 'standard',
  status: 'active',
  active: true,
});
assert(!productError, 'Could not create concurrency product', productError);

const { error: flagError } = await supabase
  .from('checkout_feature_flags')
  .update({ enabled: true, enabled_at: new Date().toISOString() })
  .eq('key', 'checkout_order_v4');
assert(!flagError, 'Could not enable the local Checkout V4 flag', flagError);

const { data: context, error: contextError } = await supabase.rpc('resolve_portal_commercial_context_v2', {
  p_guest_intent: true,
});
assert(!contextError && context?.status === 'guest', 'Guest context resolution failed', { contextError, context });

const { data: cart, error: cartError } = await supabase.rpc('resolve_checkout_cart_v4', {
  p_cart_items: cartItems,
  p_guest_intent: true,
});
assert(!cartError && cart?.ok === true, 'Cart resolution failed', { cartError, cart });

const { data: begun, error: beginError } = await supabase.rpc('begin_checkout_request_v1', {
  p_request_key: requestKey,
  p_recovery_token: recoveryToken,
  p_expected_actor_scope: 'guest',
  p_expected_context_token: context.contextToken,
  p_expected_commercial_version: null,
  p_cart_fingerprint: cart.cartFingerprint,
  p_cart_items: cartItems,
  p_customer_data: customerData,
  p_delivery_data: deliveryData,
  p_payment_method: 'bank_transfer',
  p_payment_timing: 'before_delivery',
});
assert(!beginError && begun?.ok === true, 'Durable request creation failed', { beginError, begun });

const createArgs = {
  p_request_key: requestKey,
  p_request_fingerprint: begun.requestFingerprint,
  p_expected_context_token: context.contextToken,
  p_expected_commercial_version: null,
  p_cart_fingerprint: cart.cartFingerprint,
  p_cart_items: cartItems,
  p_customer_data: customerData,
  p_delivery_data: deliveryData,
  p_payment_method: 'bank_transfer',
  p_payment_timing: 'before_delivery',
  p_payment_data: { bank_reference: 'V4-CONCURRENT-001' },
};
const [first, second] = await Promise.all([
  supabase.rpc('create_checkout_order_v4', createArgs),
  supabase.rpc('create_checkout_order_v4', createArgs),
]);
assert(!first.error && !second.error, 'A concurrent caller failed', { first: first.error, second: second.error });
assert(first.data?.orderNumber === second.data?.orderNumber, 'Concurrent callers returned different orders', {
  first: first.data,
  second: second.data,
});

const { data: orders, error: ordersError } = await supabase
  .from('orders')
  .select('id,order_number')
  .eq('email', email);
assert(!ordersError && orders?.length === 1, 'Concurrency created more or fewer than one order', { ordersError, orders });

const orderId = orders[0].id;
const [items, reservations, payments, emails, requests] = await Promise.all([
  supabase.from('order_items').select('id').eq('order_id', orderId),
  supabase.from('inventory_reservations').select('id').eq('order_id', orderId),
  supabase.from('payments').select('id').eq('order_id', orderId),
  supabase.from('email_queue').select('id').eq('related_id', orderId),
  supabase.from('checkout_requests_v4').select('id,status,order_id').eq('request_key', requestKey),
]);
assert(items.data?.length === 1, 'Expected one order line', items);
assert(reservations.data?.length === 1, 'Expected one inventory reservation', reservations);
assert(payments.data?.length === 1, 'Expected one payment', payments);
assert(emails.data?.length === 1, 'Expected one queued customer email', emails);
assert(requests.data?.length === 1 && requests.data[0].status === 'committed', 'Expected one committed durable request', requests);

console.log(JSON.stringify({
  ok: true,
  requestKey,
  orderNumber: first.data.orderNumber,
  replayObserved: first.data.replayed === true || second.data.replayed === true,
  counts: { orders: 1, items: 1, reservations: 1, payments: 1, emails: 1, requests: 1 },
}, null, 2));
