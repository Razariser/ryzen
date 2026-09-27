// api/order.js
// Orders CRUD/stats (admin-only), order CREATION (customer-facing, via
// action=create), and the Razorpay webhook (action=webhook, no auth) —
// all in one file, to stay under Vercel Hobby's 12-function cap.
//
// ARCHITECTURE: orders, order_items, and payments live in NEON (business
// source of truth, rules 3/5). Supabase is used ONLY to (a) verify who a
// customer is via their JWT, on `create`, and (b) enrich admin views with
// customer name/email/phone from Supabase's `customers` table — never as
// storage for order data itself.
//
// Because the webhook needs the RAW request body to verify Razorpay's
// signature, this file disables Vercel's automatic body parsing for ALL
// actions and parses JSON manually for the admin/create actions instead.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sql } = require('./_lib/neon');
const { supabase } = require('./_lib/supabase'); // existing anon/service client, used for admin customer-enrichment lookups
const { requireAuth } = require('./_lib/auth');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'];
const STATUS_LABELS = { pending: 'Pending', paid: 'Paid', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };

module.exports.config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkPerm(session, action) {
  if (session.role === 'super_admin') return true;
  const perm = (session.permissions && session.permissions.orders) || {};
  if (['update-status', 'update-tracking', 'add-note'].includes(action)) return !!perm.edit;
  return !!perm.view;
}

// Builds the same API shape the admin dashboard already expects,
// from a Neon order row + its items + its latest payment row.
function toApi(order, items, payment, customer) {
  return {
    id: order.id,
    customerId: order.supabase_user_id,
    customerName: customer?.name,
    customerEmail: customer?.email,
    customerPhone: customer?.phone,
    items: (items || []).map((i) => ({
      variantId: i.variant_id,
      name: i.product_name,
      price: Number(i.unit_price),
      quantity: i.quantity,
      lineTotal: Number(i.line_total),
    })),
    amount: Number(order.grand_total),
    status: order.status,
    razorpayOrderId: payment?.razorpay_order_id || null,
    razorpayPaymentId: payment?.razorpay_payment_id || null,
    trackingNumber: order.tracking_number || null,
    courier: order.courier || null,
    paymentStatus: payment?.status || 'pending',
    customerNotes: order.customer_notes || '',
    adminNotes: order.admin_notes || '',
    timeline: order.timeline || [],
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function enrichCustomers(supabaseUserIds) {
  const uniqueIds = [...new Set(supabaseUserIds.filter(Boolean))];
  if (!uniqueIds.length) return {};
  const { data, error } = await supabase.from('customers').select('id, name, email, phone').in('id', uniqueIds);
  if (error) {
    console.error('order.js: customer enrichment lookup failed', error);
    return {};
  }
  const map = {};
  for (const c of data) map[c.id] = c;
  return map;
}

/* ───────────────────────── Razorpay webhook (no auth) ───────────────────────── */
function verifyWebhookSignature(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleWebhook(rawBody, req, res) {
  const signature = req.headers['x-razorpay-signature'] || '';
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    console.error('order.js webhook: RAZORPAY_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = payload.event;
  const paymentEntity = payload.payload && payload.payload.payment && payload.payload.payment.entity;
  if (!paymentEntity) return res.status(200).json({ received: true });

  try {
    const razorpayOrderId = paymentEntity.order_id;
    const razorpayPaymentId = paymentEntity.id;

    const paymentRows = await sql`
      SELECT id, order_id FROM payments WHERE razorpay_order_id = ${razorpayOrderId} LIMIT 1
    `;

    if (!paymentRows.length) {
      // Order was never created via action=create (e.g. created directly in
      // Razorpay's dashboard, or a bug elsewhere). We can't safely insert a
      // new order here — orders.supabase_user_id is NOT NULL and we have no
      // way to know who the customer is from the webhook payload alone.
      console.error(`order.js webhook: no payment row found for razorpay_order_id=${razorpayOrderId}`);
      return res.status(200).json({ received: true, warning: 'no matching order, see server logs' });
    }

    const { id: paymentId, order_id: orderId } = paymentRows[0];

    if (event === 'payment.captured') {
      const amount = paymentEntity.amount / 100; // Razorpay sends paise

      await sql`
        UPDATE payments SET status = 'captured', razorpay_payment_id = ${razorpayPaymentId}, updated_at = now()
        WHERE id = ${paymentId}
      `;

      const orderRows = await sql`SELECT timeline FROM orders WHERE id = ${orderId}`;
      const timeline = Array.isArray(orderRows[0]?.timeline) ? orderRows[0].timeline : [];
      timeline.push({ status: 'paid', note: 'Payment captured via Razorpay webhook', at: new Date().toISOString(), by: 'razorpay-webhook' });

      await sql`
        UPDATE orders SET status = 'paid', timeline = ${JSON.stringify(timeline)}, updated_at = now()
        WHERE id = ${orderId}
      `;
    }

    if (event === 'payment.failed') {
      await sql`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = ${paymentId}`;

      const orderRows = await sql`SELECT timeline FROM orders WHERE id = ${orderId}`;
      const timeline = Array.isArray(orderRows[0]?.timeline) ? orderRows[0].timeline : [];
      timeline.push({ status: 'cancelled', note: 'Payment failed via Razorpay webhook', at: new Date().toISOString(), by: 'razorpay-webhook' });

      await sql`
        UPDATE orders SET status = 'cancelled', timeline = ${JSON.stringify(timeline)}, updated_at = now()
        WHERE id = ${orderId}
      `;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('order.js webhook error:', err);
    // Still 200 so Razorpay doesn't hammer retries — check Vercel logs.
    return res.status(200).json({ received: true, warning: 'logged error, see server logs' });
  }
}

/* ───────────────────── Order creation (customer-facing, no admin auth) ───────────────────── */
async function handleCreate(body, req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not signed in' });

  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Not signed in' });
  const supabaseUserId = userData.user.id;

  const { amount, items, address, coupon } = body || {};
  if (!amount || !(amount > 0)) return res.status(400).json({ error: 'Invalid amount' });
  if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });
  if (!address) return res.status(400).json({ error: 'Address is required' });

  let couponId = null;
  if (coupon) {
    const couponRows = await sql`SELECT id FROM coupons WHERE code = ${coupon} AND is_active = true`;
    if (couponRows.length) couponId = couponRows[0].id;
    else console.warn(`order.js create: coupon code "${coupon}" not found or inactive, ignoring`);
  }

  const amountPaise = Math.round(Number(amount) * 100);
  const rzpResp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64'),
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt: `razariser_${Date.now()}`,
      notes: { supabase_user_id: supabaseUserId },
    }),
  });
  if (!rzpResp.ok) {
    console.error('Razorpay order creation failed:', await rzpResp.text());
    return res.status(502).json({ error: 'Could not create payment order' });
  }
  const rzpOrder = await rzpResp.json();

  // NOTE: subtotal/discount/shipping aren't broken out by the client today
  // (it only sends a single `amount`) — subtotal and grand_total are set
  // equal here, matching prior behavior. Worth revisiting: compute pricing
  // server-side from `items` rather than trusting client-sent `amount`.
  const orderRows = await sql`
    INSERT INTO orders (supabase_user_id, status, subtotal, discount_total, shipping_total, grand_total, coupon_id, shipping_address)
    VALUES (${supabaseUserId}, 'pending', ${amount}, 0, 0, ${amount}, ${couponId}, ${JSON.stringify(address)})
    RETURNING id
  `;
  const orderId = orderRows[0].id;

  for (const item of items) {
    const variantId = item.variantId || item.variant_id || item.id;
    const productName = item.name || item.title || 'Unknown item';
    const unitPrice = Number(item.price ?? item.unitPrice ?? 0);
    const quantity = Number(item.quantity ?? item.qty ?? 1);
    await sql`
      INSERT INTO order_items (order_id, variant_id, product_name, unit_price, quantity, line_total)
      VALUES (${orderId}, ${variantId}, ${productName}, ${unitPrice}, ${quantity}, ${unitPrice * quantity})
    `;
  }

  await sql`
    INSERT INTO payments (order_id, razorpay_order_id, amount, status)
    VALUES (${orderId}, ${rzpOrder.id}, ${amount}, 'created')
  `;

  return res.status(200).json({
    id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    key: RAZORPAY_KEY_ID,
  });
}

/* ───────────────────────── Admin-facing order actions ───────────────────────── */
async function getLatestPayments(orderIds) {
  if (!orderIds.length) return {};
  const rows = await sql`
    SELECT DISTINCT ON (order_id) order_id, razorpay_order_id, razorpay_payment_id, status
    FROM payments WHERE order_id = ANY(${orderIds}) ORDER BY order_id, created_at DESC
  `;
  const map = {};
  for (const r of rows) map[r.order_id] = r;
  return map;
}

async function handleList(req, res) {
  const status = req.query.status;
  const limit = Math.min(Number(req.query.limit) || 50, 1000);
  const offset = Number(req.query.offset) || 0;
  const from = req.query.from;
  const to = req.query.to;

  let orders;
  if (status && VALID_STATUSES.includes(status) && from && to) {
    orders = await sql`SELECT * FROM orders WHERE status = ${status} AND created_at >= ${from} AND created_at <= ${to} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  } else if (status && VALID_STATUSES.includes(status)) {
    orders = await sql`SELECT * FROM orders WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  } else if (from && to) {
    orders = await sql`SELECT * FROM orders WHERE created_at >= ${from} AND created_at <= ${to} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  } else {
    orders = await sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  }

  const orderIds = orders.map((o) => o.id);
  const itemRows = orderIds.length ? await sql`SELECT * FROM order_items WHERE order_id = ANY(${orderIds})` : [];
  const itemsByOrder = {};
  for (const it of itemRows) (itemsByOrder[it.order_id] ||= []).push(it);

  const paymentsByOrder = await getLatestPayments(orderIds);
  const customerMap = await enrichCustomers(orders.map((o) => o.supabase_user_id));

  const result = orders.map((o) => toApi(o, itemsByOrder[o.id], paymentsByOrder[o.id], customerMap[o.supabase_user_id]));
  const [{ count }] = await sql`SELECT COUNT(*) AS count FROM orders`;
  return res.status(200).json({ orders: result, total: Number(count) });
}

async function handleGet(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const orderRows = await sql`SELECT * FROM orders WHERE id = ${id}`;
  if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
  const order = orderRows[0];

  const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;
  const paymentsByOrder = await getLatestPayments([Number(id)]);
  const customerMap = await enrichCustomers([order.supabase_user_id]);

  return res.status(200).json({ order: toApi(order, items, paymentsByOrder[order.id], customerMap[order.supabase_user_id]) });
}

async function handleUpdateStatus(body, session, res) {
  const { id, status, note } = body;
  if (!id || !status) return res.status(400).json({ error: 'Order id and status are required' });
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${VALID_STATUSES.join(', ')}` });

  const rows = await sql`SELECT timeline FROM orders WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const timeline = Array.isArray(rows[0].timeline) ? rows[0].timeline : [];
  timeline.push({ status, note: note || `Marked ${STATUS_LABELS[status] || status}`, at: new Date().toISOString(), by: session.username || session.role });

  const updated = await sql`
    UPDATE orders SET status = ${status}, timeline = ${JSON.stringify(timeline)}, updated_at = now()
    WHERE id = ${id} RETURNING *
  `;
  const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;
  const paymentsByOrder = await getLatestPayments([Number(id)]);
  return res.status(200).json({ order: toApi(updated[0], items, paymentsByOrder[updated[0].id]) });
}

async function handleUpdateTracking(body, session, res) {
  const { id, trackingNumber, courier } = body;
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const rows = await sql`SELECT timeline FROM orders WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const timeline = Array.isArray(rows[0].timeline) ? rows[0].timeline : [];
  timeline.push({ status: null, note: `Tracking updated: ${courier || 'courier'} — ${trackingNumber || 'no number'}`, at: new Date().toISOString(), by: session.username || session.role });

  const updated = await sql`
    UPDATE orders SET tracking_number = ${trackingNumber || null}, courier = ${courier || null}, timeline = ${JSON.stringify(timeline)}, updated_at = now()
    WHERE id = ${id} RETURNING *
  `;
  const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;
  const paymentsByOrder = await getLatestPayments([Number(id)]);
  return res.status(200).json({ order: toApi(updated[0], items, paymentsByOrder[updated[0].id]) });
}

async function handleAddNote(body, session, res) {
  const { id, note } = body;
  if (!id || !note) return res.status(400).json({ error: 'Order id and note text are required' });

  const rows = await sql`SELECT admin_notes, timeline FROM orders WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });

  const stamp = `[${new Date().toLocaleString()} · ${session.username || session.role}] ${note}`;
  const combinedNotes = rows[0].admin_notes ? `${rows[0].admin_notes}\n${stamp}` : stamp;
  const timeline = Array.isArray(rows[0].timeline) ? rows[0].timeline : [];
  timeline.push({ status: null, note: `Note added: ${note}`, at: new Date().toISOString(), by: session.username || session.role });

  const updated = await sql`
    UPDATE orders SET admin_notes = ${combinedNotes}, timeline = ${JSON.stringify(timeline)}, updated_at = now()
    WHERE id = ${id} RETURNING *
  `;
  const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;
  const paymentsByOrder = await getLatestPayments([Number(id)]);
  return res.status(200).json({ order: toApi(updated[0], items, paymentsByOrder[updated[0].id]) });
}

async function handleStats(req, res) {
  const orderRows = await sql`SELECT grand_total, status, created_at, supabase_user_id FROM orders`;
  const paidStatuses = ['paid', 'shipped', 'delivered'];
  const paidOrders = orderRows.filter((o) => paidStatuses.includes(o.status));
  const totalRevenue = paidOrders.reduce((sum, o) => sum + Number(o.grand_total || 0), 0);
  const totalOrders = orderRows.length;
  const totalCustomers = new Set(orderRows.map((o) => o.supabase_user_id)).size;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentPaid = paidOrders.filter((o) => new Date(o.created_at) >= thirtyDaysAgo);
  const byDay = {};
  recentPaid.forEach((o) => {
    const day = new Date(o.created_at).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(o.grand_total || 0);
  });
  const revenueTrend = Object.entries(byDay).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, amount]) => ({ date, amount }));

  return res.status(200).json({ totalRevenue, totalOrders, totalCustomers, revenueTrend });
}

/* ───────────────────────── Router ───────────────────────── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-razorpay-signature');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const rawBody = req.method === 'POST' ? await readRawBody(req) : '';

  if (action === 'webhook') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return handleWebhook(rawBody, req, res);
  }

  let body = {};
  if (rawBody) {
    try { body = JSON.parse(rawBody); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  req.body = body;

  // Customer-facing, no admin session required.
  if (action === 'create') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      return await handleCreate(body, req, res);
    } catch (err) {
      console.error('order.js create error:', err);
      return res.status(500).json({ error: 'Unexpected server error' });
    }
  }

  // Everything below is admin-only.
  try {
    const session = requireAuth(req, res);
    if (!session) return;
    if (!checkPerm(session, action)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }

    if (req.method === 'GET' && action === 'list') return await handleList(req, res);
    if (req.method === 'GET' && action === 'get') return await handleGet(req, res);
    if (req.method === 'GET' && action === 'stats') return await handleStats(req, res);
    if (req.method === 'POST' && action === 'update-status') return await handleUpdateStatus(body, session, res);
    if (req.method === 'POST' && action === 'update-tracking') return await handleUpdateTracking(body, session, res);
    if (req.method === 'POST' && action === 'add-note') return await handleAddNote(body, session, res);

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('order.js error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
