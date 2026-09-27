// supabase/functions/create-order/index.ts
//
// Creates a Razorpay order for the signed-in user's cart and records it in
// NEON (orders, order_items, payments — business source of truth, rules
// 3/5), instead of Supabase. Still called from the storefront exactly as
// before via:
//   window.supabaseClient.functions.invoke('create-order', { body: {...} })
// which automatically attaches the caller's auth token, so we can still
// trust the verified user id here — Supabase is now used ONLY to confirm
// who's calling (rule 1/8/9), not to store the order.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { neon } from "https://esm.sh/@neondatabase/serverless@0.9.0";

const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!;
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NEON_DATABASE_URL = Deno.env.get("NEON_DATABASE_URL")!;

const sql = neon(NEON_DATABASE_URL);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Client tied to the caller's own JWT — used only to identify who they are.
    const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Not signed in" }, 401);
    }
    const supabaseUserId = userData.user.id;

    const body = await req.json();
    const { amount, items, address, coupon } = body || {};

    if (!amount || !(amount > 0)) return json({ error: "Invalid amount" }, 400);
    if (!items || !Array.isArray(items) || !items.length) return json({ error: "Cart is empty" }, 400);
    if (!address) return json({ error: "Address is required" }, 400);

    // ---- Resolve coupon code -> coupon_id in Neon, if provided ----
    let couponId: number | null = null;
    if (coupon) {
      const couponRows = await sql`SELECT id FROM coupons WHERE code = ${coupon} AND is_active = true`;
      if (couponRows.length) couponId = couponRows[0].id;
      else console.warn(`create-order: coupon code "${coupon}" not found or inactive, ignoring`);
    }

    // Razorpay amounts are in paise, and must be an integer.
    const amountPaise = Math.round(Number(amount) * 100);

    const rzpResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `razariser_${Date.now()}`,
        notes: { supabase_user_id: supabaseUserId },
      }),
    });

    if (!rzpResp.ok) {
      const errText = await rzpResp.text();
      console.error("Razorpay order creation failed:", errText);
      return json({ error: "Could not create payment order" }, 502);
    }
    const rzpOrder = await rzpResp.json();

    // ---- Write the order into Neon ----
    // NOTE: subtotal/discount/shipping aren't broken out by the client
    // today (it only sends a single `amount`), so subtotal and grand_total
    // are set equal here, matching prior behavior.
    const orderRows = await sql`
      INSERT INTO orders (supabase_user_id, status, subtotal, discount_total, shipping_total, grand_total, coupon_id, shipping_address)
      VALUES (${supabaseUserId}, 'pending', ${amount}, 0, 0, ${amount}, ${couponId}, ${JSON.stringify(address)})
      RETURNING id
    `;
    const orderId = orderRows[0].id;

    // ---- Write order_items ----
    for (const item of items) {
      const variantId = item.variantId || item.variant_id || item.id;
      const productName = item.name || item.title || "Unknown item";
      const unitPrice = Number(item.price ?? item.unitPrice ?? 0);
      const quantity = Number(item.quantity ?? item.qty ?? 1);
      await sql`
        INSERT INTO order_items (order_id, variant_id, product_name, unit_price, quantity, line_total)
        VALUES (${orderId}, ${variantId}, ${productName}, ${unitPrice}, ${quantity}, ${unitPrice * quantity})
      `;
    }

    // ---- Write the payment record ----
    await sql`
      INSERT INTO payments (order_id, razorpay_order_id, amount, status)
      VALUES (${orderId}, ${rzpOrder.id}, ${amount}, 'created')
    `;

    return json({
      id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      key: RAZORPAY_KEY_ID, // public key id — safe to expose to the client
    });
  } catch (e) {
    console.error("create-order error:", e);
    return json({ error: "Unexpected server error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
