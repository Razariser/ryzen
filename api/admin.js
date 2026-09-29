// api/admin.js
// Login + dashboard summary + AI assistant chat.
//
// NOTE: assistant.js was merged into this file (as action=assistant) to
// stay under Vercel Hobby's 12-serverless-function-per-deployment limit.
// Nothing about how the assistant works changed — same Gemini call, same
// read-only context, same auth requirement. Only its file location moved.
// You can delete api/assistant.js once this is deployed.

const { signToken, requireAuth, TOKEN_TTL_MS } = require('./_lib/auth');
const { supabase } = require('./_lib/supabase');
const { verifyPassword } = require('./_lib/passwords');
const { getJSON } = require('./_lib/github');
// Per-role dashboards: one backend module per seat, kept outside api/ so they
// don't count as extra Vercel functions. See Roles-dashboard.js/index.js.
const RoleDashboards = require('../Roles-dashboard.js/index.js');
// CFO's real financial data, reused as-is by the AI assistant below — the
// assistant is never shown a number the CFO dashboard itself doesn't show.
const CFOModule = require('../Roles-dashboard.js/CFO.js');

const FULL_PERMISSIONS = {
  products: { view: true, edit: true, delete: true },
  pages: { view: true, edit: true, delete: true },
  orders: { view: true, edit: true },
  traffic: { view: true },
  admins: { view: true, edit: true, delete: true },
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Every Gemini call in this file goes through here. Free-tier rate limits
// are shared across the WHOLE project — every feature, every Telegram bot,
// every Cron job draws from the same pool — so bursts of activity (testing
// several features back to back, several Telegram bots replying near-
// simultaneously) can genuinely trip a 429. This retries with a short
// backoff before giving up, rather than surfacing a raw error on what's
// often just a transient, self-resolving rate limit.
async function fetchGeminiWithRetry(body, maxRetries = 2) {
  let lastRes;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (lastRes.status !== 429 || attempt === maxRetries) return lastRes;
    const backoffMs = 1500 * Math.pow(2, attempt); // 1.5s, then 3s
    console.log(`Gemini 429 — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  return lastRes;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Logs every login attempt — success AND failure. adminId is null when the
// attempt failed before we could match a real admin (bad username or wrong
// password). Returns the new row's id so the frontend can later attach GPS
// coordinates to this specific login (only happens on success).
async function logLogin(adminId, attemptedUsername, success, req) {
  try {
    const { data, error } = await supabase
      .from('admin_logins')
      .insert({
        admin_id: adminId,
        attempted_username: attemptedUsername || null,
        success,
        ip_address: getClientIp(req),
        user_agent: req.headers['user-agent'] || 'unknown',
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id;
  } catch (err) {
    console.error('logLogin failed:', err.message);
    return null;
  }
}

async function sendTelegramAlert(admin, req, faceStatus) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const faceLine = faceStatus === 'mismatch'
      ? '\n⚠️ FACE MISMATCH'
      : faceStatus === 'verified'
      ? '\n✅ Face verified'
      : '';

    const message =
      `🔐 Razariser Admin Login\n` +
      `User: ${admin.username} (${admin.role})\n` +
      `IP: ${ip}\n` +
      `Device: ${userAgent}\n` +
      `Time: ${time}${faceLine}\n` +
      `📍 Exact location: pending browser permission…`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch (err) {
    console.error('sendTelegramAlert failed:', err.message);
  }
}

// Fires once the browser's geolocation prompt resolves (handleUpdateLocation
// below), separately from sendTelegramAlert above — GPS coordinates aren't
// available yet at login time, only after the async browser permission
// prompt completes. Sends a native Telegram location pin (renders as an
// in-app map) plus a follow-up message with TWO tappable buttons that open
// straight into Google Maps/whatever navigation app is set as default:
// one drops a pin at the exact coordinate, the other starts live turn-by-
// turn navigation there. Both use the same raw lat/long — "exact" isn't a
// separate, more-precise reading, it's the same GPS fix rendered as a pin
// instead of a route; accuracyMeters (from the browser's own accuracy
// estimate) is shown so it's clear how tight that fix actually was.
async function sendLocationAlert(username, role, latitude, longitude, accuracyMeters) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    await fetch(`https://api.telegram.org/bot${token}/sendLocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, latitude, longitude }),
    });

    const pinLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
    const navigateLink = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`;
    const accuracyLine = typeof accuracyMeters === 'number' ? `\nGPS accuracy: ±${Math.round(accuracyMeters)}m` : '';

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `📍 Exact login location confirmed\nUser: ${username} (${role})${accuracyLine}\nTap a button below — opens directly in Google Maps.`,
        reply_markup: {
          inline_keyboard: [[
            { text: '📍 Exact Location', url: pinLink },
            { text: '🧭 Navigate There', url: navigateLink },
          ]],
        },
      }),
    });
  } catch (err) {
    console.error('sendLocationAlert failed:', err.message);
  }
}

async function sendFailedLoginAlert(attemptedUsername, req, reason) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const message =
      `🚫 Failed Razariser Admin Login\n` +
      `Attempted username: ${attemptedUsername || 'unknown'}\n` +
      `IP: ${ip}\n` +
      `Device: ${userAgent}\n` +
      `Time: ${time}` +
      (reason ? `\nReason: ${reason}` : '');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch (err) {
    console.error('sendFailedLoginAlert failed:', err.message);
  }
}

// Shared by both wrong-password and wrong-role-selection failures below —
// one code path for anything that counts as a failed login attempt, so the
// brute-force counter and face-lock threshold apply consistently to both.
// `reason` is internal-only (goes to the Telegram alert for Hunter's own
// visibility) — the client always gets back the same generic message
// regardless of reason, so a wrong role selection can't be used as an
// oracle to confirm a password was actually correct.
async function recordFailedLoginAttempt(admin, attemptedUsername, req, reason) {
  await logLogin(admin ? admin.id : null, attemptedUsername, false, req);
  await sendFailedLoginAlert(attemptedUsername, req, reason);
  if (admin) {
    const nextCount = (admin.failed_attempt_count || 0) + 1;
    const updates = { failed_attempt_count: nextCount };
    if (nextCount >= 3) updates.face_lock = true;
    await supabase.from('admins').update(updates).eq('id', admin.id);
  }
}

const GENERIC_LOGIN_ERROR = 'Incorrect username, password, or role.';

async function handleLogin(req, res) {
  const { username, password, role } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!role) {
    return res.status(400).json({ error: 'Select your role before signing in.' });
  }

  const { data: admin, error } = await supabase
    .from('admins')
    .select('*')
    .eq('username', username)
    .maybeSingle();

  if (error) throw error;

  if (!admin || !verifyPassword(password, admin.password_hash)) {
    // Log the failed attempt before responding — this is what feeds
    // Monitor Agent's brute-force detection.
    await recordFailedLoginAttempt(admin, username, req, 'wrong password');
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  if (admin.deactivated_at) {
    return res.status(401).json({ error: 'This account has been deactivated.' });
  }

  // Password is correct — now confirm the role they picked on the login
  // screen actually matches this account. Super Admin must pick
  // "super_admin"; a sub-admin must pick their own assigned org_title
  // exactly. A mismatch is treated the same as a wrong password: logged,
  // alerted, and counted toward the 3-strikes face-lock — a real second
  // factor, not a cosmetic dropdown. The response is deliberately the
  // SAME generic error as a wrong password, so nobody probing this form
  // can tell from the response alone whether the password was right.
  const expectedRole = admin.role === 'super_admin' ? 'super_admin' : admin.org_title;
  if (!expectedRole || role !== expectedRole) {
    await recordFailedLoginAttempt(admin, username, req, expectedRole ? `wrong role selected (picked "${role}")` : 'correct password, but this account has no role assigned yet');
    return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }

  // Correct password. If this account is face-locked (3+ prior failures)
  // and already has a reference photo enrolled, don't issue a token yet —
  // require a face-recognition challenge first. Applies to every role.
  if (admin.face_lock && admin.face_reference_path) {
    return res.status(200).json({
      requiresFaceVerification: true,
      adminId: admin.id,
    });
  }

  // Otherwise: correct password is enough. This also covers the case where
  // face_lock is set but no reference photo exists yet — that just means
  // this admin has never enrolled, so this login IS their enrollment
  // opportunity (per: "each admin enrolls their own face the first time
  // they log in successfully").
  await supabase.from('admins').update({ failed_attempt_count: 0, face_lock: false }).eq('id', admin.id);

  const loginLogId = await logLogin(admin.id, admin.username, true, req);
  await sendTelegramAlert(admin, req);

  const token = signToken({
    sub: admin.id,
    role: admin.role,
    username: admin.username,
    permissions: admin.role === 'super_admin' ? FULL_PERMISSIONS : (admin.permissions || {}),
    exp: Date.now() + TOKEN_TTL_MS,
  });

  return res.status(200).json({
    token,
    expiresInMs: TOKEN_TTL_MS,
    role: admin.role,
    mustChangePassword: !!admin.must_change_password,
    mustEnrollFace: !admin.face_reference_path,
    orgTitle: admin.org_title || null,
    // Where a sub-admin with an assigned role should land after signing in.
    dashboardPath: admin.role === 'super_admin' ? null : RoleDashboards.pathFor(admin.org_title),
    // The frontend uses this to optionally attach exact GPS coordinates
    // to this login via action=update-location, if the admin grants
    // browser location permission.
    loginLogId,
  });
}

// Called separately by the frontend right after a successful login, only
// if the browser's geolocation prompt was accepted. Attaches exact GPS
// coordinates to the login row created in handleLogin. This is the only
// way to get an EXACT location — IP address alone can only ever give an
// approximate city/region, never a precise position.
async function handleUpdateLocation(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { loginLogId, latitude, longitude, accuracy } = req.body || {};
  if (!loginLogId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'loginLogId, latitude, and longitude are required.' });
  }

  const { data, error } = await supabase
    .from('admin_logins')
    .update({ latitude, longitude })
    .eq('id', loginLogId)
    .eq('admin_id', session.sub) // can only update your own login row
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (data) await sendLocationAlert(session.username, session.role, latitude, longitude, typeof accuracy === 'number' ? accuracy : null);
  return res.status(200).json({ ok: true });
}

async function handleDashboard(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data: admin } = await supabase
    .from('admins')
    .select('deactivated_at, org_title, username, active_mode')
    .eq('id', session.sub)
    .maybeSingle();

  if (admin?.deactivated_at) {
    return res.status(401).json({ error: 'This account has been deactivated.' });
  }

  let productCount = 0;
  let pageCount = 0;

  try {
    const { count } = await supabase.from('products').select('*', { count: 'exact', head: true });
    productCount = count || 0;
  } catch (err) {
    console.error('dashboard: products count failed:', err.message);
  }

  try {
    const { count } = await supabase.from('pages').select('*', { count: 'exact', head: true });
    pageCount = count || 0;
  } catch (err) {
    console.error('dashboard: pages count failed:', err.message);
  }

  let orderCount = 0;
  try {
    const { count } = await supabase.from('orders').select('*', { count: 'exact', head: true });
    orderCount = count || 0;
  } catch (err) {
    console.error('dashboard: orders count failed:', err.message);
  }

  let activeRoles = [];
  try {
    const { data: rolesData } = await supabase.from('admin_active_roles').select('role_title').eq('admin_id', session.sub);
    activeRoles = (rolesData || []).map((r) => r.role_title);
  } catch (err) {
    console.error('dashboard: active roles fetch failed:', err.message);
  }

  return res.status(200).json({
    stats: { products: productCount, pages: pageCount, orders: orderCount },
    role: session.role,
    permissions: session.permissions || {},
    orgTitle: session.role === 'super_admin' ? 'Board of Directors' : (admin?.org_title || null),
    dashboardPath: session.role === 'super_admin' ? null : RoleDashboards.pathFor(admin?.org_title),
    activeRoles,
    username: admin?.username || null,
  });
}

async function handleLoginLogs(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data, error } = await supabase
    .from('admin_logins')
    .select('created_at, ip_address, user_agent, success, attempted_username, latitude, longitude, admins ( username, role )')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('handleLoginLogs failed:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const logins = (data || []).map((row) => ({
    when: row.created_at,
    username: row.admins?.username || row.attempted_username || 'unknown',
    role: row.admins?.role || 'unknown',
    success: row.success,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    latitude: row.latitude,
    longitude: row.longitude,
  }));

  return res.status(200).json({ logins });
}

/* ── Merged from assistant.js — read-only chat, no write path at all ── */
async function buildAssistantContext() {
  let productsSummary = 'No products loaded.';
  let pagesSummary = 'No pages loaded.';

  try {
    const { data: products } = await getJSON('public/products.json');
    if (Array.isArray(products) && products.length) {
      productsSummary = products
        .slice(0, 50)
        .map((p) => `- ${p.name} (${p.catLabel || p.cat}), ₹${p.price}${p.badge ? ', badge: ' + p.badge : ''}`)
        .join('\n');
    }
  } catch (err) {
    console.error('assistant: failed to load products.json context:', err.message);
  }

  try {
    const { data: pages, error } = await supabase
      .from('pages')
      .select('slug, title, type')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    if (Array.isArray(pages) && pages.length) {
      pagesSummary = pages.map((p) => `- ${p.title} (${p.type}, /${p.slug})`).join('\n');
    }
  } catch (err) {
    console.error('assistant: failed to load pages context:', err.message);
  }

  return `Current products in the store:\n${productsSummary}\n\nCurrent pages:\n${pagesSummary}`;
}

// Real, honest per-role grounding for the mode switcher. Roles with no
// dedicated data source say so explicitly rather than inventing context —
// same principle as everywhere else in this panel.
/* ── Real tool-calling per role, via Gemini function calling. Boundary
   held consistently with the auto-deploy refusal: business-data tools are
   READ-ONLY (fetch fresh real data on demand instead of stale pre-fetched
   context) — no role can mutate products, orders, pages, admins, or
   deployments through a tool call. Personal Assistant gets full CRUD on
   notes because those are personal, low-stakes, and instantly reversible —
   a fundamentally different risk profile from live business/financial data. ── */

const TOOL_HANDLERS = {
  async getOrderStats() {
    const { data, count } = await supabase.from('orders').select('amount, status', { count: 'exact' }).limit(5000);
    const revenue = (data || [])
      .filter((o) => o.status && o.status !== 'created' && o.status !== 'cancelled')
      .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    return { totalOrders: count || 0, revenue };
  },
  async getProductList() {
    const { data: products } = await getJSON('public/products.json');
    if (!Array.isArray(products)) return { count: 0, products: [] };
    return {
      count: products.length,
      products: products.slice(0, 40).map((p) => ({ name: p.name, category: p.catLabel || p.cat, price: p.price })),
    };
  },
  async getPageList() {
    const { data } = await supabase.from('pages').select('slug, title, type').order('created_at', { ascending: false }).limit(40);
    return { count: (data || []).length, pages: data || [] };
  },
  async getSystemStatus() {
    const token = process.env.VERCEL_API_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (!token || !projectId) return { configured: false };
    const url = new URL('https://api.vercel.com/v6/deployments');
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', '3');
    const vRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!vRes.ok) return { configured: true, error: `Vercel API error ${vRes.status}` };
    const data = await vRes.json();
    return { configured: true, recentDeployments: (data.deployments || []).map((d) => ({ state: d.state, createdAt: d.createdAt })) };
  },
  async getMarketingOverviewTool() {
    const ctx = await buildMarketingContext();
    return ctx;
  },
  async getCfoFinancials() {
    try {
      const { snapshot } = await CFOModule.assistantBrief({ supabase, getJSON });
      return snapshot;
    } catch (err) {
      console.error('getCfoFinancials tool failed:', err.message);
      return { error: 'Could not load financial data right now.' };
    }
  },
  async checkPricingConsistency() {
    const { data: products } = await getJSON('public/products.json');
    if (!Array.isArray(products) || !products.length) return { outliers: [], note: 'No product data available.' };

    const byCategory = {};
    products.forEach((p) => {
      const cat = p.catLabel || p.cat || 'Uncategorized';
      const price = Number(p.price);
      if (!isFinite(price)) return;
      (byCategory[cat] = byCategory[cat] || []).push({ name: p.name, price });
    });

    const outliers = [];
    Object.entries(byCategory).forEach(([cat, items]) => {
      if (items.length < 3) return; // not enough in-category data for a meaningful comparison
      const prices = items.map((i) => i.price);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev === 0) return;
      items.forEach((i) => {
        const zScore = (i.price - mean) / stdDev;
        if (Math.abs(zScore) >= 1.5) {
          outliers.push({ product: i.name, category: cat, price: i.price, categoryAverage: Math.round(mean), direction: zScore > 0 ? 'above average' : 'below average' });
        }
      });
    });
    return { outliers, note: 'Simple statistical outlier check (z-score >= 1.5 within category) — not a judgment on whether the price is wrong, just where to look.' };
  },
  async listNotes(args, session) {
    const { data } = await supabase.from('admin_notes').select('id, content, done').eq('admin_id', session.sub).order('created_at', { ascending: false }).limit(30);
    return { notes: data || [] };
  },
  async createNote(args, session) {
    if (!args.content) return { error: 'content is required' };
    const { data } = await supabase.from('admin_notes').insert({ admin_id: session.sub, content: args.content }).select('id').single();
    return { created: true, id: data?.id };
  },
  async toggleNoteDone(args, session) {
    if (!args.id) return { error: 'id is required' };
    await supabase.from('admin_notes').update({ done: !!args.done }).eq('id', args.id).eq('admin_id', session.sub);
    return { updated: true };
  },
  async deleteNote(args, session) {
    if (!args.id) return { error: 'id is required' };
    await supabase.from('admin_notes').delete().eq('id', args.id).eq('admin_id', session.sub);
    return { deleted: true };
  },
};

const TOOL_DECLARATIONS = {
  getOrderStats: { name: 'getOrderStats', description: 'Get real total order count and revenue right now.', parameters: { type: 'OBJECT', properties: {} } },
  getProductList: { name: 'getProductList', description: 'Get the real current product catalog.', parameters: { type: 'OBJECT', properties: {} } },
  getPageList: { name: 'getPageList', description: 'Get the real current list of website pages.', parameters: { type: 'OBJECT', properties: {} } },
  getSystemStatus: { name: 'getSystemStatus', description: 'Get real recent Vercel deployment status.', parameters: { type: 'OBJECT', properties: {} } },
  getMarketingOverviewTool: { name: 'getMarketingOverviewTool', description: 'Get real marketing overview data: products, customers, page views, cart/wishlist activity.', parameters: { type: 'OBJECT', properties: {} } },
  getCfoFinancials: { name: 'getCfoFinancials', description: 'Get real CFO financial data: the last 6 months of P&L (revenue, COGS, opex, gross profit, EBITDA, net profit), current budget vs actual, cash balances, receivables and payables aging with the oldest overdue items by name, revenue/margin targets, investments, tax records, open management actions, and recent expenses. Use this for anything beyond the current-month summary already given — trends, comparisons across months, or naming specific overdue customers/vendors.', parameters: { type: 'OBJECT', properties: {} } },
  checkPricingConsistency: { name: 'checkPricingConsistency', description: 'Real statistical check for products priced as outliers within their own category.', parameters: { type: 'OBJECT', properties: {} } },
  listNotes: { name: 'listNotes', description: "List the admin's own saved notes/reminders.", parameters: { type: 'OBJECT', properties: {} } },
  createNote: { name: 'createNote', description: 'Save a new note/reminder for the admin.', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING' } }, required: ['content'] } },
  toggleNoteDone: { name: 'toggleNoteDone', description: 'Mark a note done or not done.', parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' }, done: { type: 'BOOLEAN' } }, required: ['id', 'done'] } },
  deleteNote: { name: 'deleteNote', description: 'Delete a note.', parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } }, required: ['id'] } },
};

// Which tools each persona is allowed to use — deliberately not "every tool
// everywhere." A role only gets tools relevant to its real domain.
const ROLE_TOOL_NAMES = {
  personal: ['listNotes', 'createNote', 'toggleNoteDone', 'deleteNote'],
  CMO: ['getMarketingOverviewTool', 'checkPricingConsistency'],
  CFO: ['getCfoFinancials'],
  COO: ['getOrderStats'],
  'CDO (Data)': ['getOrderStats'],
  CPO: ['getProductList'],
  'CDO (Design)': ['getProductList'],
  CECO: ['getPageList'],
  CTO: ['getSystemStatus'],
};

function getToolsForPersona(persona) {
  const names = ROLE_TOOL_NAMES[persona];
  if (!names || !names.length) return null;
  return [{ function_declarations: names.map((n) => TOOL_DECLARATIONS[n]) }];
}

// The actual function-calling loop: ask Gemini, execute any tool calls it
// makes against REAL data, feed the result back, repeat up to a small cap
// so a confused model can't loop forever inside one request.
async function logAiUsage(feature, persona, success, errorMessage, tokensIn, tokensOut, latencyMs) {
  try {
    await supabase.from('ai_usage_logs').insert({
      feature, persona, success,
      error_message: errorMessage || null,
      tokens_in: tokensIn || null,
      tokens_out: tokensOut || null,
      latency_ms: latencyMs || null,
    });
  } catch (err) {
    console.error('logAiUsage failed:', err.message);
  }
}

async function runGeminiWithTools(systemInstruction, contents, tools, session, logMeta) {
  let workingContents = [...contents];
  const MAX_ROUNDS = 4;
  const startTime = Date.now();
  let totalTokensIn = 0, totalTokensOut = 0;
  const feature = logMeta?.feature || 'assistant';
  const persona = logMeta?.persona || null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = { system_instruction: systemInstruction, contents: workingContents };
    if (tools) body.tools = tools;

    const geminiRes = await fetchGeminiWithRetry(body);
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('runGeminiWithTools: Gemini API error:', geminiRes.status, errText);
      logAiUsage(feature, persona, false, `Gemini ${geminiRes.status}`, totalTokensIn, totalTokensOut, Date.now() - startTime);
      return 'AI service error — try again in a moment.';
    }
    const data = await geminiRes.json();
    totalTokensIn += data.usageMetadata?.promptTokenCount || 0;
    totalTokensOut += data.usageMetadata?.candidatesTokenCount || 0;
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart) {
      logAiUsage(feature, persona, true, null, totalTokensIn, totalTokensOut, Date.now() - startTime);
      return parts.map((p) => p.text || '').join('') || 'No response generated.';
    }

    const { name, args } = functionCallPart.functionCall;
    const handler = TOOL_HANDLERS[name];
    let result;
    try {
      result = handler ? await handler(args || {}, session) : { error: `Unknown tool: ${name}` };
    } catch (err) {
      console.error('tool handler failed:', name, err.message);
      result = { error: 'Tool execution failed.' };
    }

    workingContents.push({ role: 'model', parts: [{ functionCall: { name, args } }] });
    workingContents.push({ role: 'function', parts: [{ functionResponse: { name, response: { result } } }] });
  }

  logAiUsage(feature, persona, false, 'Reached tool-call round limit', totalTokensIn, totalTokensOut, Date.now() - startTime);
  return 'Reached the tool-call limit for this turn — try rephrasing or asking a narrower question.';
}

async function buildRoleContext(persona, session) {
  if (persona === 'personal' || !persona) {
    let notesText = 'No notes/reminders saved yet.';
    try {
      const { data: notes } = await supabase
        .from('admin_notes')
        .select('content, done, created_at')
        .eq('admin_id', session.sub)
        .order('created_at', { ascending: false })
        .limit(30);
      if (Array.isArray(notes) && notes.length) {
        notesText = notes.map((n) => `- [${n.done ? 'done' : 'open'}] ${n.content}`).join('\n');
      }
    } catch (err) {
      console.error('buildRoleContext personal: notes fetch failed:', err.message);
    }
    return { promptRole: 'a Personal Assistant', context: `The admin's saved notes/reminders:\n${notesText}` };
  }

  if (persona === 'CMO') {
    const mc = await buildMarketingContext();
    return { promptRole: 'Razariser\'s Chief Marketing Officer (CMO)', context: marketingContextToPromptText(mc) };
  }

  // Shared cheap counts, reused by several personas below.
  let productCount = 0, pageCount = 0, orderCount = 0;
  try {
    const [{ count: pc }, { count: pgc }, { count: oc }] = await Promise.all([
      supabase.from('products').select('*', { count: 'exact', head: true }),
      supabase.from('pages').select('*', { count: 'exact', head: true }),
      supabase.from('orders').select('*', { count: 'exact', head: true }),
    ]);
    productCount = pc || 0; pageCount = pgc || 0; orderCount = oc || 0;
  } catch (err) {
    console.error('buildRoleContext shared counts failed:', err.message);
  }

  if (persona === 'CTO') {
    const hasVercelToken = !!(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID);
    return {
      promptRole: 'Razariser\'s Chief Technology Officer (CTO)',
      context: hasVercelToken
        ? 'Real deployment status is available via the System tab (Vercel API connected). Direct the admin there for live deploy history — you do not have it inline here.'
        : 'No Vercel API token configured yet, so no live deployment data is available. Say so plainly rather than guessing at system health.',
    };
  }
  if (persona === 'CFO') {
    try {
      const { text } = await CFOModule.assistantBrief({ supabase, getJSON });
      return { promptRole: 'Razariser\'s Chief Financial Officer (CFO)', context: text };
    } catch (err) {
      console.error('buildRoleContext CFO: assistantBrief failed:', err.message);
      return { promptRole: 'Razariser\'s Chief Financial Officer (CFO)', context: 'Financial data could not be loaded just now — do not invent revenue, margin, or cash figures. Say so plainly and suggest checking the CFO dashboard directly or trying again.' };
    }
  }
  if (persona === 'COO') {
    return {
      promptRole: 'Razariser\'s Chief Operations Officer (COO)',
      context: orderCount > 0
        ? `Real order count: ${orderCount}. Detailed financials (revenue, margins) are available in the Reports tab.`
        : `Razariser has 0 orders so far — there is no real operations history yet. Do not invent fulfillment figures. Speak in terms of what to set up and watch for once real orders start.`,
    };
  }
  if (persona === 'CPO' || persona === 'CDO (Design)') {
    return {
      promptRole: persona === 'CPO' ? 'Razariser\'s Chief Product Officer (CPO)' : 'Razariser\'s Chief Design Officer',
      context: `Real product catalog count: ${productCount} products. Open the Products tab for full detail.`,
    };
  }
  if (persona === 'CECO') {
    return { promptRole: 'Razariser\'s Chief E-Commerce Officer (CECO)', context: `Real site page count: ${pageCount} pages. Open the Website tab for full detail.` };
  }
  if (persona === 'CDO (Data)') {
    return {
      promptRole: 'Razariser\'s Chief Data Officer',
      context: orderCount > 0
        ? `Real order count: ${orderCount}. Forecasting and trend data live in the Marketing tab's Forecast card once there are enough orders.`
        : `0 orders so far — there is no real dataset to analyze yet. Say so plainly rather than inventing trends.`,
    };
  }
  if (persona === 'CAIO') {
    return {
      promptRole: 'Razariser\'s Chief AI & Innovation Officer (CAIO)',
      context: 'Real AI features currently live in Razariser: the Marketing Director AI (CMO), this Assistant, and AI-based face recognition for admin login security. No local LLM, agent framework, or additional AI infrastructure exists beyond these.',
    };
  }
  // CLO, CHRO, CCO — genuinely nothing built yet for these.
  return {
    promptRole: `Razariser's ${persona}`,
    context: `No dedicated module or real data source exists for this function in Razariser yet — this seat is currently unstaffed by any system feature. Give general, sound advice for this domain, but be explicit that you have no company-specific data to ground it in.`,
  };
}

async function handleAssistant(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  const { message, history, persona } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing "message" in request body.' });
  }

  const effectivePersona = persona || 'personal';
  let promptRole = 'a Personal Assistant';
  let context = '';
  if (effectivePersona === 'personal') {
    context = await buildAssistantContext();
    const { context: notesContext } = await buildRoleContext('personal', session);
    context += '\n\n' + notesContext;
  } else {
    const roleCtx = await buildRoleContext(effectivePersona, session);
    promptRole = roleCtx.promptRole;
    context = roleCtx.context;
  }

  const tools = getToolsForPersona(effectivePersona);
  const systemInstruction = {
    parts: [
      {
        text:
          `You are operating as ${promptRole} inside the Razariser store's admin panel. ` +
          'Razariser is a premium men\'s fashion brand (T-shirts, cargo pants, joggers, co-ords) sold via pre-order. ' +
          (effectivePersona === 'personal'
            ? 'You help the admin manage products and pages, write product descriptions, keep track of notes/reminders they\'ve saved, and answer questions about their store data. '
            : `Speak and advise as this role would, grounded only in the real data given below. `) +
          (tools
            ? 'You have access to real, live tools listed below — use them whenever you need current data rather than guessing from the context text, which may be slightly stale. '
            : 'You have READ-ONLY access to the data below — you cannot create, edit, or delete anything yourself. ') +
          (effectivePersona !== 'personal'
            ? 'For anything beyond your available tools — creating, editing, or deleting products, pages, orders, or any business record — clearly explain what you\'d suggest and tell the admin to apply it themselves in the relevant tab. You cannot and must not claim to have made such a change. '
            : '') +
          'Be concise and practical. Never invent data, statistics, or history that isn\'t given to you or returned by a tool.\n\n' + context,
      },
    ],
  };

  // Server-side memory is the source of truth for continuity — not
  // whatever the client happens to send. Falls back to client-sent
  // `history` only if the memory fetch fails for some reason.
  let priorTurns = [];
  try {
    const { data: memRows } = await supabase
      .from('admin_role_memory')
      .select('role, content')
      .eq('admin_id', session.sub)
      .eq('role_title', effectivePersona)
      .order('created_at', { ascending: true })
      .limit(40);
    priorTurns = (memRows || []).map((m) => ({ role: m.role, text: m.content }));
  } catch (err) {
    console.error('handleAssistant: memory fetch failed, falling back to client history:', err.message);
    priorTurns = Array.isArray(history) ? history : [];
  }

  const contents = [
    ...priorTurns.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const finalReply = await runGeminiWithTools(systemInstruction, contents, tools, session, { feature: 'assistant-panel', persona: effectivePersona });

  // Fire-and-forget — persisted memory shouldn't block or fail the reply itself.
  saveRoleMemoryTurn(session.sub, effectivePersona, message, finalReply);

  return res.status(200).json({ reply: finalReply });
}

/* ── System: real deployment status via Vercel API (no CPU/RAM — that
   doesn't exist for stateless serverless functions, so we don't fake it) ── */
// Real access check: Super Admin always passes. Otherwise, look up the
// requesting admin's CURRENT org_title fresh from the DB (not from the JWT,
// since a title change shouldn't require the sub-admin to re-login to take
// effect) and check it against the allowed list for this resource.
async function hasOrgTitleAccess(session, allowedTitles) {
  if (session.role === 'super_admin') return true;
  const { data } = await supabase.from('admins').select('org_title').eq('id', session.sub).maybeSingle();
  return !!(data && data.org_title && allowedTitles.includes(data.org_title));
}

// Writes one row to admin_logs for any privileged write below. Best-effort:
// a logging failure should never block the action itself, so it only
// console.errors rather than throwing.
async function logAdminAction(session, action, targetId, details) {
  try {
    await supabase.from('admin_logs').insert({
      actor_id: session.sub,
      action,
      target_id: targetId || null,
      details: details || {},
    });
  } catch (err) {
    console.error('logAdminAction failed:', err.message);
  }
}

/* ── Terms & Policy consent: shown after every successful sign-in until the
   admin has agreed to the CURRENT version. The agreement is recorded in
   admin_logs (action 'terms_accepted', with the version, IP and device),
   so it persists across devices and doubles as an audit record. Bump
   TERMS_VERSION whenever the wording changes and everyone is asked again. ── */
const TERMS_VERSION = '1.0';

async function handleTermsStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data, error } = await supabase
    .from('admin_logs')
    .select('details')
    .eq('actor_id', session.sub)
    .eq('action', 'terms_accepted')
    .limit(50);
  if (error) throw error;

  const accepted = (data || []).some((r) => r.details && r.details.version === TERMS_VERSION);
  return res.status(200).json({ accepted, version: TERMS_VERSION });
}

async function handleTermsAccept(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { version } = req.body || {};
  if (version !== TERMS_VERSION) {
    return res.status(409).json({ error: 'The Terms were updated. Reload the page and sign in again to review them.' });
  }

  // Not best-effort like logAdminAction: if the agreement can't be
  // recorded, say so rather than pretending it was.
  const { error } = await supabase.from('admin_logs').insert({
    actor_id: session.sub,
    action: 'terms_accepted',
    target_id: session.sub,
    details: {
      version: TERMS_VERSION,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      acceptedAt: new Date().toISOString(),
    },
  });
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

/* ── Finance Command Center: real numbers from `expenses`, `tax_records`,
   and `returns` — the ONLY financial tables that currently exist. No
   profit/margin figures here since `product_costs` has no rows yet; once
   it's populated, gross margin can be added as expenses joined against
   revenue from /api/order. Until then this reports spend and refunds
   only — never a fabricated profit number. Super Admin or CFO seat. ── */
async function handleFinanceOverview(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CFO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CFO seat.' });
  }

  const [expensesRes, taxRes, returnsRes] = await Promise.all([
    supabase.from('expenses').select('id, spent_on, category, description, amount, paid_to').order('spent_on', { ascending: false }),
    supabase.from('tax_records').select('period, tax_type, collected, paid, filed_on').order('period', { ascending: false }).limit(6),
    supabase.from('returns').select('status, refund_amount'),
  ]);
  if (expensesRes.error) throw expensesRes.error;
  if (taxRes.error) throw taxRes.error;
  if (returnsRes.error) throw returnsRes.error;

  const expenses = expensesRes.data || [];
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const byCategory = {};
  expenses.forEach((e) => {
    byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount || 0);
  });

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthExpenses = expenses
    .filter((e) => (e.spent_on || '').startsWith(monthKey))
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const returns = returnsRes.data || [];
  const refundedTotal = returns
    .filter((r) => r.status === 'refunded')
    .reduce((sum, r) => sum + Number(r.refund_amount || 0), 0);
  const pendingRefunds = returns.filter((r) => r.status === 'requested' || r.status === 'approved').length;

  return res.status(200).json({
    totalExpenses,
    monthExpenses,
    expensesByCategory: byCategory,
    recentExpenses: expenses.slice(0, 15),
    taxRecords: taxRes.data || [],
    refundedTotal,
    pendingRefunds,
    dataAvailable: expenses.length > 0 || returns.length > 0,
  });
}

async function handleExpenseCreate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CFO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CFO seat.' });
  }
  const { spent_on, category, description, amount, paid_to } = req.body || {};
  if (!spent_on || !category || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'spent_on, category, and amount are required.' });
  }
  if (Number(amount) < 0) return res.status(400).json({ error: 'amount cannot be negative.' });

  const { data, error } = await supabase
    .from('expenses')
    .insert({ spent_on, category, description: description || null, amount, paid_to: paid_to || null })
    .select('*')
    .single();
  if (error) throw error;

  await logAdminAction(session, 'expense_create', data.id, { category, amount, spent_on });
  return res.status(200).json({ expense: data });
}

async function handleExpenseDelete(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CFO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CFO seat.' });
  }
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) throw error;

  await logAdminAction(session, 'expense_delete', id, {});
  return res.status(200).json({ success: true });
}

/* ── Inventory Command Center: real `stock_levels` + `warehouses` tables.
   Both currently empty — this is genuinely new surface area, not a
   reskin of the product catalog. Status thresholds come straight from
   each row's own `reorder_at`, never a hardcoded number. Super Admin
   or COO seat. ── */
async function handleInventoryOverview(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['COO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the COO seat.' });
  }

  const [stockRes, warehousesRes] = await Promise.all([
    supabase.from('stock_levels').select('id, product_name, size, warehouse_id, quantity, reorder_at, updated_at').order('product_name'),
    supabase.from('warehouses').select('id, name, city'),
  ]);
  if (stockRes.error) throw stockRes.error;
  if (warehousesRes.error) throw warehousesRes.error;

  const warehouses = warehousesRes.data || [];
  const whMap = {};
  warehouses.forEach((w) => { whMap[w.id] = w; });

  const stock = (stockRes.data || []).map((s) => ({
    ...s,
    warehouseName: whMap[s.warehouse_id]?.name || 'Unassigned',
    status: s.quantity <= 0 ? 'out' : s.quantity <= s.reorder_at ? 'low' : 'healthy',
  }));

  return res.status(200).json({
    totalUnits: stock.reduce((sum, s) => sum + Number(s.quantity || 0), 0),
    outOfStock: stock.filter((s) => s.status === 'out').length,
    lowStock: stock.filter((s) => s.status === 'low').length,
    warehouseCount: warehouses.length,
    warehouses,
    stock,
    dataAvailable: stock.length > 0,
  });
}

async function handleWarehouseCreate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['COO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the COO seat.' });
  }
  const { name, city } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required.' });

  const { data, error } = await supabase.from('warehouses').insert({ name: name.trim(), city: city || null }).select('*').single();
  if (error) throw error;

  await logAdminAction(session, 'warehouse_create', data.id, { name, city });
  return res.status(200).json({ warehouse: data });
}

// Handles both: editing an existing stock row (pass id) and creating a new
// one (pass product_name/size/warehouse_id instead). One endpoint because
// the frontend's stock table uses the same inline-edit row for both.
async function handleStockAdjust(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['COO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the COO seat.' });
  }
  const { id, product_name, size, warehouse_id, quantity, reorder_at } = req.body || {};

  if (id) {
    const updates = { updated_at: new Date().toISOString() };
    if (quantity !== undefined) {
      if (Number(quantity) < 0) return res.status(400).json({ error: 'quantity cannot be negative.' });
      updates.quantity = quantity;
    }
    if (reorder_at !== undefined) updates.reorder_at = reorder_at;

    const { data, error } = await supabase.from('stock_levels').update(updates).eq('id', id).select('*').single();
    if (error) throw error;

    await logAdminAction(session, 'stock_adjust', id, updates);
    return res.status(200).json({ stock: data });
  }

  if (!product_name || !size || !warehouse_id) {
    return res.status(400).json({ error: 'product_name, size, and warehouse_id are required for a new stock row.' });
  }
  const { data, error } = await supabase
    .from('stock_levels')
    .insert({ product_name, size, warehouse_id, quantity: quantity ?? 0, reorder_at: reorder_at ?? 5 })
    .select('*')
    .single();
  if (error) throw error;

  await logAdminAction(session, 'stock_create', data.id, { product_name, size, quantity: data.quantity });
  return res.status(200).json({ stock: data });
}

/* ── Returns Command Center: real `returns` table, zero rows today but
   fully wired end-to-end. Every status change is audited and traceable
   to `order_ref`. Return rate isn't computed yet — it needs a total
   order count over a matching window, which lives in api/order.js, not
   here; left null with a note rather than guessed. Super Admin, COO,
   or CFO. ── */
async function handleReturnsList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['COO', 'CFO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin, COO, or CFO.' });
  }
  const { data, error } = await supabase.from('returns').select('*').order('created_at', { ascending: false });
  if (error) throw error;

  const returns = data || [];
  const byStatus = {};
  returns.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  return res.status(200).json({
    returns,
    byStatus,
    returnRate: null,
    dataAvailable: returns.length > 0,
  });
}

async function handleReturnUpdateStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['COO', 'CFO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin, COO, or CFO.' });
  }
  const { id, status, refund_amount } = req.body || {};
  const allowed = ['requested', 'approved', 'received', 'refunded', 'rejected'];
  if (!id || !status) return res.status(400).json({ error: 'id and status are required.' });
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });

  const updates = { status };
  if (refund_amount !== undefined) updates.refund_amount = refund_amount;

  const { data, error } = await supabase.from('returns').update(updates).eq('id', id).select('*').single();
  if (error) throw error;

  await logAdminAction(session, 'return_status_update', id, { status, refund_amount });
  return res.status(200).json({ return: data });
}

/* ── Analytics: traffic comes from the `page_views` table, which the
   storefront is already writing to (398 real rows) — nothing new needed
   there, this just surfaces it. Sales-by-product and conversion analytics
   stay out for now: `orders` and `products` have zero rows, so those
   sections would be nothing but zeros pretending to be insight. Visible to
   any logged-in admin since it's aggregate, non-financial traffic data. ── */
async function handleAnalyticsOverview(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data: rows, error } = await supabase
    .from('page_views')
    .select('path, user_agent, created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw error;

  const views = rows || [];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 86400000);

  const viewsToday = views.filter((v) => new Date(v.created_at) >= startOfToday).length;
  const views7d = views.filter((v) => new Date(v.created_at) >= sevenDaysAgo).length;

  const byPath = {};
  views.forEach((v) => {
    const p = v.path || '(unknown)';
    byPath[p] = (byPath[p] || 0) + 1;
  });
  const topPages = Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }));

  const byDay = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(startOfToday.getTime() - i * 86400000);
    byDay[d.toISOString().slice(0, 10)] = 0;
  }
  views.forEach((v) => {
    const key = new Date(v.created_at).toISOString().slice(0, 10);
    if (key in byDay) byDay[key] += 1;
  });
  const trend = Object.entries(byDay).map(([date, count]) => ({ date, count }));

  let mobile = 0;
  let desktop = 0;
  views.forEach((v) => {
    const ua = (v.user_agent || '').toLowerCase();
    if (/mobile|android|iphone|ipad/.test(ua)) mobile += 1; else desktop += 1;
  });

  return res.status(200).json({
    totalViews: views.length,
    viewsToday,
    views7d,
    uniquePages: Object.keys(byPath).length,
    topPages,
    trend,
    deviceSplit: { mobile, desktop },
    dataAvailable: views.length > 0,
  });
}

async function handleSystemStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CTO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CTO seat.' });
  }

  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID; // optional, only needed for team accounts

  if (!token || !projectId) {
    return res.status(200).json({
      configured: false,
      message: 'Add VERCEL_API_TOKEN and VERCEL_PROJECT_ID in Vercel env vars to enable real deployment status here.',
    });
  }

  try {
    const url = new URL('https://api.vercel.com/v6/deployments');
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', '5');
    if (teamId) url.searchParams.set('teamId', teamId);

    const vercelRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!vercelRes.ok) {
      const errText = await vercelRes.text();
      console.error('Vercel API error:', vercelRes.status, errText);
      return res.status(502).json({ error: `Vercel API error (${vercelRes.status})` });
    }
    const data = await vercelRes.json();
    const deployments = (data.deployments || []).map((d) => ({
      id: d.uid,
      state: d.state, // READY | ERROR | BUILDING | QUEUED | CANCELED
      target: d.target,
      createdAt: d.createdAt,
      url: d.url,
      commitMessage: d.meta?.githubCommitMessage || null,
    }));

    return res.status(200).json({ configured: true, deployments });
  } catch (err) {
    console.error('handleSystemStatus failed:', err.message);
    return res.status(500).json({ error: 'Could not reach Vercel API.' });
  }
}

/* ── Maintenance Mode: real, Super-Admin-only kill switch. Stored in
   Supabase so status/history persist and are visible from any device.
   NOTE: flipping this flag only records intent + notifies via Telegram —
   your storefront (index.html or wherever it's served from) needs to
   actually check this flag server-side and redirect/serve a backup page
   when it's on. This endpoint is the source of truth for that check.

   Cooldown auto-off: turning maintenance ON can carry an optional
   cooldown (5 / 10 / 30 min), stored as cooldown_seconds + cooldown_ends_at
   on the same row. There is no reliable always-on background timer on
   serverless/Vercel Hobby (cron there is capped at once/day — see the
   Daily Cron Brief note further down), so this is CHECKED rather than
   scheduled: every read of status (this endpoint — polled by the admin
   panel every few seconds while the Maintenance tab is open — plus the
   Telegram /status command) lazily flips the switch back off the moment
   the cooldown has passed. In practice that means the flip happens within
   a few seconds of the timer hitting zero as long as an admin has the
   panel open somewhere (or the very next time anyone checks), not at the
   exact instant the countdown reaches 00:00 with nobody watching at all.
   While a cooldown is running, Super Admin can push it back with fixed
   +5 minute extensions (maintenance-extend) rather than picking a new
   duration from scratch.

   Requires adding two columns to the existing store_maintenance_status
   table (run once via the Supabase SQL editor):

     alter table store_maintenance_status add column if not exists cooldown_seconds integer;
     alter table store_maintenance_status add column if not exists cooldown_ends_at timestamptz;
── */
const MAINTENANCE_COOLDOWN_PRESETS_MIN = [5, 10, 30];
const MAINTENANCE_EXTEND_MINUTES = 5;

// Cooldown auto-off is CHECKED on every read, not scheduled — see the
// comment above. Given the freshest row, flips is_on back to false (and
// clears the cooldown fields) if its cooldown has passed, and returns the
// resulting row (unchanged if nothing needed to happen).
async function maybeAutoExpireMaintenance(row) {
  if (!row || !row.is_on || !row.cooldown_ends_at) return row;
  if (new Date(row.cooldown_ends_at) > new Date()) return row;

  await applyMaintenanceChange({ on: false, reason: '', changedBy: 'System (cooldown timer)' });
  return { is_on: false, reason: null, cooldown_seconds: null, cooldown_ends_at: null, updated_at: new Date().toISOString() };
}

// PUBLIC — no auth required. This is what the storefront's middleware.js
// calls, on every page request, to decide whether to show the real site or
// the maintenance page. Deliberately returns only on/reason — no cooldown
// timestamps, no "changed by", nothing an anonymous visitor should see.
// Side benefit: real storefront traffic now also runs the same lazy
// cooldown-expiry check the admin panel does, so with live visitors the
// cooldown actually flips off within moments of hitting zero, not just
// "whenever an admin's panel happens to poll next."
async function handleMaintenancePublicStatus(req, res) {
  const { data, error } = await supabase
    .from('store_maintenance_status')
    .select('is_on, reason, cooldown_seconds, cooldown_ends_at, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  const current = await maybeAutoExpireMaintenance(data);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    on: !!(current && current.is_on),
    reason: current ? current.reason : null,
  });
}

async function handleMaintenanceStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { data, error } = await supabase
    .from('store_maintenance_status')
    .select('is_on, reason, cooldown_seconds, cooldown_ends_at, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  const current = await maybeAutoExpireMaintenance(data);

  return res.status(200).json({
    on: !!(current && current.is_on),
    reason: current ? current.reason : null,
    cooldownSeconds: current ? current.cooldown_seconds : null,
    cooldownEndsAt: current ? current.cooldown_ends_at : null,
    updatedAt: current ? current.updated_at : null,
  });
}

// Shared by both the admin-panel toggle (below) and the Telegram webhook,
// so there is exactly one code path that ever writes the actual state.
// cooldownSeconds is only meaningful when on === true; turning off (by any
// path — manual, Telegram, or the auto-expiry check above) always clears
// the cooldown fields so a stale timer never lingers into the next session.
async function applyMaintenanceChange({ on, reason, changedBy, cooldownSeconds }) {
  const finalReason = on ? reason.trim() : null;
  const finalCooldownSeconds = on ? (cooldownSeconds || null) : null;
  const cooldownEndsAt = finalCooldownSeconds ? new Date(Date.now() + finalCooldownSeconds * 1000).toISOString() : null;

  const { error: upsertError } = await supabase
    .from('store_maintenance_status')
    .upsert({
      id: 1,
      is_on: on,
      reason: finalReason,
      cooldown_seconds: finalCooldownSeconds,
      cooldown_ends_at: cooldownEndsAt,
      updated_by: changedBy,
      updated_at: new Date().toISOString(),
    });
  if (upsertError) throw upsertError;

  await supabase.from('store_maintenance_log').insert({
    is_on: on,
    reason: finalReason,
    changed_by: changedBy,
  });

  return { on, reason: finalReason, cooldownSeconds: finalCooldownSeconds, cooldownEndsAt };
}

async function handleMaintenanceToggle(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { on, reason, cooldownMinutes } = req.body || {};
  if (typeof on !== 'boolean') {
    return res.status(400).json({ error: '"on" (boolean) is required.' });
  }
  if (on && (!reason || !reason.trim())) {
    return res.status(400).json({ error: 'A reason is required to turn maintenance mode on.' });
  }

  let cooldownSeconds = null;
  if (on && cooldownMinutes != null) {
    if (!MAINTENANCE_COOLDOWN_PRESETS_MIN.includes(cooldownMinutes)) {
      return res.status(400).json({ error: 'cooldownMinutes must be one of: ' + MAINTENANCE_COOLDOWN_PRESETS_MIN.join(', ') });
    }
    cooldownSeconds = cooldownMinutes * 60;
  }

  const result = await applyMaintenanceChange({ on, reason: reason || '', changedBy: session.username, cooldownSeconds });

  // Uses its OWN dedicated bot (TELEGRAM_BOT_TOKEN_MAINTENANCE /
  // TELEGRAM_CHAT_ID_MAINTENANCE) — separate from the login-alert bot
  // (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), same one-bot-per-purpose pattern
  // used for the per-role bots elsewhere in this file. Falls back to the
  // shared login bot only if the dedicated pair isn't configured. If
  // neither is set, this is a silent no-op.
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN_MAINTENANCE || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID_MAINTENANCE || process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const text = on
        ? `🔴 Maintenance Mode turned ON by ${session.username}\nReason: ${result.reason}${result.cooldownSeconds ? `\nAuto-off in: ${result.cooldownSeconds / 60} min` : ''}\nTime: ${time}`
        : `🟢 Maintenance Mode turned OFF by ${session.username}\nTime: ${time}`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }
  } catch (err) {
    console.error('maintenance-toggle: Telegram alert failed:', err.message);
  }

  return res.status(200).json(result);
}

// "+5 min" — pushes an already-running cooldown further out by a fixed
// 5-minute step (stacking presses = +5, +5, +5, ...) rather than letting
// the Super Admin pick an arbitrary new duration mid-session.
async function handleMaintenanceExtend(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { data, error } = await supabase
    .from('store_maintenance_status')
    .select('is_on, reason, cooldown_seconds, cooldown_ends_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;

  const current = await maybeAutoExpireMaintenance(data);
  if (!current || !current.is_on) {
    return res.status(400).json({ error: 'Maintenance mode is not currently on.' });
  }
  if (!current.cooldown_ends_at) {
    return res.status(400).json({ error: 'This session has no cooldown timer running to extend.' });
  }

  const addSeconds = MAINTENANCE_EXTEND_MINUTES * 60;
  const base = new Date(current.cooldown_ends_at) > new Date() ? new Date(current.cooldown_ends_at) : new Date();
  const newEndsAt = new Date(base.getTime() + addSeconds * 1000).toISOString();
  const newCooldownSeconds = (current.cooldown_seconds || 0) + addSeconds;

  const { error: updateError } = await supabase
    .from('store_maintenance_status')
    .update({ cooldown_ends_at: newEndsAt, cooldown_seconds: newCooldownSeconds, updated_by: session.username, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (updateError) throw updateError;

  await supabase.from('store_maintenance_log').insert({
    is_on: true,
    reason: current.reason ? `${current.reason} (cooldown +${MAINTENANCE_EXTEND_MINUTES} min)` : `Cooldown +${MAINTENANCE_EXTEND_MINUTES} min`,
    changed_by: session.username,
  });

  return res.status(200).json({ success: true, cooldownEndsAt: newEndsAt, cooldownSeconds: newCooldownSeconds });
}

// Two-way control: the Maintenance Mode bot can flip the switch, not just
// announce it. Bypasses requireAuth entirely (Telegram calls this, not the
// admin panel) — verified instead by a dedicated webhook secret AND by
// requiring the message come from the exact configured chat, since a
// command here can take the live store down. Setup:
//   1. Set TELEGRAM_BOT_TOKEN_MAINTENANCE, TELEGRAM_CHAT_ID_MAINTENANCE,
//      and TELEGRAM_WEBHOOK_SECRET_MAINTENANCE (any random string you pick)
//      as Vercel env vars, then redeploy.
//   2. Register the webhook once:
//      https://api.telegram.org/bot<TOKEN>/setWebhook?url=<your-domain>/api/admin?action=maintenance-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET_MAINTENANCE>
//   3. In the bot's chat, send: /on <reason>, /off, or /status
async function handleMaintenanceTelegramWebhook(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET_MAINTENANCE;
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!secret || incomingSecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const message = req.body?.message;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true }); // nothing to do, but ack so Telegram stops retrying
  }

  const chatId = message.chat.id;
  const expectedChatId = process.env.TELEGRAM_CHAT_ID_MAINTENANCE;
  if (!expectedChatId || String(chatId) !== String(expectedChatId)) {
    // Silently ignore commands from any chat other than the one configured
    // for this bot — no error detail leaked back to an unrecognized chat.
    return res.status(200).json({ ok: true });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN_MAINTENANCE;
  const text = message.text.trim();
  const senderName = message.from?.username ? '@' + message.from.username : (message.from?.first_name || 'Telegram');

  async function reply(msg) {
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
    } catch (err) {
      console.error('maintenance-webhook: reply failed:', err.message);
    }
  }

  try {
    if (/^\/status\b/i.test(text)) {
      const { data } = await supabase.from('store_maintenance_status').select('is_on, reason, cooldown_seconds, cooldown_ends_at, updated_at').eq('id', 1).maybeSingle();
      const current = await maybeAutoExpireMaintenance(data);
      let statusText = '🟢 LIVE';
      if (current && current.is_on) {
        const cooldownNote = current.cooldown_ends_at
          ? ` (auto-off in ~${Math.max(0, Math.round((new Date(current.cooldown_ends_at) - Date.now()) / 60000))} min)`
          : '';
        statusText = `🔴 DOWN — ${current.reason || 'no reason recorded'}${cooldownNote}`;
      }
      await reply(`Current status: ${statusText}`);
      return res.status(200).json({ ok: true });
    }

    if (/^\/off\b/i.test(text)) {
      await applyMaintenanceChange({ on: false, reason: '', changedBy: `Telegram (${senderName})` });
      await reply('🟢 Maintenance Mode turned OFF.');
      return res.status(200).json({ ok: true });
    }

    const onMatch = text.match(/^\/on\s+(.+)/is);
    if (onMatch) {
      const reason = onMatch[1].trim();
      await applyMaintenanceChange({ on: true, reason, changedBy: `Telegram (${senderName})` });
      await reply(`🔴 Maintenance Mode turned ON.\nReason: ${reason}`);
      return res.status(200).json({ ok: true });
    }
    if (/^\/on\b/i.test(text)) {
      await reply('A reason is required. Usage: /on <reason>');
      return res.status(200).json({ ok: true });
    }

    await reply('Commands:\n/on <reason> — take the store down\n/off — bring it back up\n/status — check current state');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('maintenance-webhook: command handling failed:', err.message);
    await reply('Something went wrong processing that — check Vercel logs.');
    return res.status(200).json({ ok: true });
  }
}

async function handleMaintenanceHistory(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { data, error } = await supabase
    .from('store_maintenance_log')
    .select('is_on, reason, changed_by, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  return res.status(200).json({ history: data || [] });
}

/* ── Integrations: real presence check only — never returns values ── */
const INTEGRATION_ENV_VARS = {
  github: { label: 'GitHub (content storage)', vars: ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'] },
  supabase: { label: 'Supabase (database)', vars: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
  gemini: { label: 'Google Gemini (AI Assistant)', vars: ['GEMINI_API_KEY'] },
  telegram: { label: 'Telegram (login alerts)', vars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] },
  telegramMaintenance: { label: 'Telegram (Maintenance Mode bot)', vars: ['TELEGRAM_BOT_TOKEN_MAINTENANCE', 'TELEGRAM_CHAT_ID_MAINTENANCE'] },
  razorpay: { label: 'Razorpay (payments/webhook)', vars: ['RAZORPAY_WEBHOOK_SECRET'] },
  vercel: { label: 'Vercel API (System status)', vars: ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID'] },
  metaAds: { label: 'Meta Ads (CMO dashboard)', vars: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'] },
  instagram: { label: 'Instagram (CMO dashboard)', vars: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID'] },
  searchConsole: { label: 'Google Search Console (CECO dashboard)', vars: ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_SITE_URL'] },
  uptimeRobot: { label: 'UptimeRobot (CTO dashboard)', vars: ['UPTIMEROBOT_API_KEY'] },
};

async function handleIntegrationsStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CTO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CTO seat.' });
  }

  const integrations = Object.entries(INTEGRATION_ENV_VARS).map(([key, def]) => ({
    key,
    label: def.label,
    configured: def.vars.every((v) => !!process.env[v]),
    missing: def.vars.filter((v) => !process.env[v]),
  }));

  return res.status(200).json({ integrations });
}

/* ── Face recognition (photo comparison via Gemini vision) ──────────────
   This is a separate system from webauthn.js (device Face ID/Touch ID).
   That system is left untouched; this one triggers automatically after
   3 consecutive wrong passwords, using an enrolled reference photo per
   admin. Super Admin is exempt (handled in handleLogin above). ──────── */
const FACE_BUCKET = 'admin-face-references';

function base64ToBuffer(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx > -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}

async function compareFacesWithGemini(referenceBuffer, challengeBuffer) {
  if (!GEMINI_API_KEY) {
    console.error('compareFacesWithGemini: GEMINI_API_KEY not set');
    return { match: false, confidence: 'low', reason: 'AI comparison unavailable (no API key configured).' };
  }

  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text:
            'Compare these two face photos. The first is a trusted enrolled reference photo. ' +
            'The second was just captured to verify identity. Respond with ONLY raw JSON, no markdown, ' +
            'no code fences, in exactly this shape: {"match": true or false, "confidence": "high" or "medium" or "low", "reason": "one short sentence"}. ' +
            'Be strict — if you are not reasonably confident it is the same person, set match to false.',
        },
        { inline_data: { mime_type: 'image/jpeg', data: referenceBuffer.toString('base64') } },
        { inline_data: { mime_type: 'image/jpeg', data: challengeBuffer.toString('base64') } },
      ],
    }],
  };

  try {
    const geminiRes = await fetchGeminiWithRetry(body);
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('compareFacesWithGemini: Gemini API error', geminiRes.status, errText);
      return { match: false, confidence: 'low', reason: 'AI comparison service error — failing closed (denied).' };
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      match: !!parsed.match,
      confidence: parsed.confidence || 'low',
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error('compareFacesWithGemini failed:', err.message);
    // Fail closed — if we can't get a clear answer, treat as a mismatch
    // rather than letting someone in on an ambiguous/broken comparison.
    return { match: false, confidence: 'low', reason: 'Could not complete AI comparison — failing closed (denied).' };
  }
}

// Liveness-aware version: takes a reference photo plus TWO challenge frames
// captured a couple seconds apart (the frontend prompts "turn your head" in
// between). Checks identity AND whether the two frames show natural live
// variation — a printed photo or a phone screen held up to the camera will
// look flat/static/identical between frames, or show screen glare/bezel/
// moiré, which this asks the model to flag explicitly.
//
// This is a heuristic, not certified anti-spoofing hardware — it raises the
// bar against casual photo spoofing, it doesn't guarantee against a
// determined, well-resourced attacker.
async function compareFacesWithLiveness(referenceBuffer, frame1Buffer, frame2Buffer) {
  if (!GEMINI_API_KEY) {
    console.error('compareFacesWithLiveness: GEMINI_API_KEY not set');
    return { match: false, live: false, confidence: 'low', reason: 'AI comparison unavailable (no API key configured).' };
  }

  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          text:
            'You are a security check with two jobs. Image 1 is a trusted enrolled reference photo of a real ' +
            'person. Images 2 and 3 are two frames captured a couple seconds apart from a live camera, during ' +
            'which the person was asked to turn their head slightly.\n\n' +
            'Job 1 — IDENTITY: do images 2 and 3 show the same person as image 1?\n' +
            'Job 2 — LIVENESS: do images 2 and 3 show a real, live 3D person captured by a camera, with a ' +
            'plausible natural difference in head angle/position/lighting between them — as opposed to a static ' +
            'printed photo or a phone/screen being held up to the camera (watch for: identical framing between ' +
            'frames, screen glare, a visible phone/screen bezel or edge, moiré/pixel patterns, flat unnatural ' +
            'lighting, or a photo of a face rather than a real face)?\n\n' +
            'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
            '{"match": true or false, "live": true or false, "confidence": "high" or "medium" or "low", "reason": "one short sentence covering both identity and liveness"}. ' +
            'Be strict on both counts — if you are not reasonably confident on either identity or liveness, set that field to false.',
        },
        { inline_data: { mime_type: 'image/jpeg', data: referenceBuffer.toString('base64') } },
        { inline_data: { mime_type: 'image/jpeg', data: frame1Buffer.toString('base64') } },
        { inline_data: { mime_type: 'image/jpeg', data: frame2Buffer.toString('base64') } },
      ],
    }],
  };

  try {
    const geminiRes = await fetchGeminiWithRetry(body);
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('compareFacesWithLiveness: Gemini API error', geminiRes.status, errText);
      return { match: false, live: false, confidence: 'low', reason: 'AI comparison service error — failing closed (denied).' };
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      match: !!parsed.match,
      live: !!parsed.live,
      confidence: parsed.confidence || 'low',
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error('compareFacesWithLiveness failed:', err.message);
    return { match: false, live: false, confidence: 'low', reason: 'Could not complete AI comparison — failing closed (denied).' };
  }
}

async function sendFaceChallengeToTelegram(admin, req, matchResult, imageBuffer, matchedAs) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const passed = matchResult.match && matchResult.live !== false;
    const resultLine = passed ? '✅ Face MATCHED — access granted' : '🚫 Face check FAILED — access denied';
    const livenessLine = matchResult.live === false ? '\n🕵️ Liveness check failed — possible photo/screen spoof' : '';
    const overrideLine = matchedAs === 'super_admin_override' ? '\n⚠️ Unlocked using Super Admin\'s face, not the account owner\'s own face' : '';

    const caption =
      `🧑‍💻 Razariser Face Recognition Challenge\n` +
      `User: ${admin.username} (${admin.role})\n` +
      `${resultLine}${livenessLine}${overrideLine}\n` +
      `Confidence: ${matchResult.confidence}\n` +
      `IP: ${ip}\n` +
      `Device: ${userAgent}\n` +
      `Time: ${time}`;

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'face-challenge.jpg');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!res.ok) {
      console.error('sendFaceChallengeToTelegram: Telegram error', res.status, await res.text());
    }
  } catch (err) {
    console.error('sendFaceChallengeToTelegram failed:', err.message);
  }
}

async function handleFaceChallengeVerify(req, res) {
  const { adminId, imageBase64, imageBase64Frame2 } = req.body || {};
  if (!adminId || !imageBase64 || !imageBase64Frame2) {
    return res.status(400).json({ error: 'adminId and two captured frames (imageBase64, imageBase64Frame2) are required.' });
  }

  const { data: admin, error } = await supabase.from('admins').select('*').eq('id', adminId).maybeSingle();
  if (error) throw error;
  if (!admin || admin.deactivated_at) {
    return res.status(401).json({ error: 'This account is unavailable.' });
  }
  if (!admin.face_reference_path) {
    return res.status(400).json({ error: 'No reference photo enrolled for this account yet.' });
  }

  const frame1Buffer = base64ToBuffer(imageBase64);
  const frame2Buffer = base64ToBuffer(imageBase64Frame2);

  // Try the account's own reference photo first.
  const { data: ownRefFile, error: ownDlError } = await supabase.storage.from(FACE_BUCKET).download(admin.face_reference_path);
  if (ownDlError) throw ownDlError;
  const ownReferenceBuffer = Buffer.from(await ownRefFile.arrayBuffer());
  let matchResult = await compareFacesWithLiveness(ownReferenceBuffer, frame1Buffer, frame2Buffer);
  let matchedAs = 'self';

  // If it's not their own face, and this isn't already the Super Admin's
  // own account, also try the Super Admin's enrolled face — the owner can
  // stand in and unlock any sub-admin's login this way. Still has to pass
  // the same liveness check.
  if (!(matchResult.match && matchResult.live) && admin.role !== 'super_admin') {
    const { data: owner } = await supabase.from('admins').select('id, face_reference_path').eq('role', 'super_admin').maybeSingle();
    if (owner && owner.face_reference_path) {
      const { data: ownerRefFile, error: ownerDlError } = await supabase.storage.from(FACE_BUCKET).download(owner.face_reference_path);
      if (!ownerDlError) {
        const ownerReferenceBuffer = Buffer.from(await ownerRefFile.arrayBuffer());
        const ownerMatch = await compareFacesWithLiveness(ownerReferenceBuffer, frame1Buffer, frame2Buffer);
        if (ownerMatch.match && ownerMatch.live) {
          matchResult = ownerMatch;
          matchedAs = 'super_admin_override';
        }
      }
    }
  }

  const passed = matchResult.match && matchResult.live;

  // Every challenge attempt — pass or fail — gets sent to Telegram, per
  // instruction: "each face recognition must need to sent through telegram".
  await sendFaceChallengeToTelegram(admin, req, matchResult, frame2Buffer, matchedAs);

  if (!passed) {
    await logLogin(admin.id, admin.username, false, req);
    const reasonDetail = !matchResult.match
      ? (matchResult.reason || 'no identity match')
      : `identity matched but liveness check failed: ${matchResult.reason || 'possible photo/screen spoof detected'}`;
    return res.status(401).json({ error: `Face verification failed (${reasonDetail}). This attempt was logged and sent to the owner.` });
  }

  await supabase.from('admins').update({ failed_attempt_count: 0, face_lock: false }).eq('id', admin.id);
  const loginLogId = await logLogin(admin.id, admin.username, true, req);
  await sendTelegramAlert(admin, req);

  const token = signToken({
    sub: admin.id,
    role: admin.role,
    username: admin.username,
    permissions: admin.role === 'super_admin' ? FULL_PERMISSIONS : (admin.permissions || {}),
    exp: Date.now() + TOKEN_TTL_MS,
  });

  return res.status(200).json({
    token,
    expiresInMs: TOKEN_TTL_MS,
    role: admin.role,
    mustChangePassword: !!admin.must_change_password,
    orgTitle: admin.org_title || null,
    dashboardPath: admin.role === 'super_admin' ? null : RoleDashboards.pathFor(admin.org_title),
    loginLogId,
  });
}

async function handleFaceEnrollSelf(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required.' });

  const path = `${session.sub}.jpg`;
  const buffer = base64ToBuffer(imageBase64);

  const { error: uploadError } = await supabase.storage
    .from(FACE_BUCKET)
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;

  const { error: updateError } = await supabase.from('admins').update({ face_reference_path: path }).eq('id', session.sub);
  if (updateError) throw updateError;

  return res.status(200).json({ ok: true });
}

async function handleFaceEnrollForAdmin(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { adminId, imageBase64 } = req.body || {};
  if (!adminId || !imageBase64) return res.status(400).json({ error: 'adminId and imageBase64 are required.' });

  const path = `${adminId}.jpg`;
  const buffer = base64ToBuffer(imageBase64);

  const { error: uploadError } = await supabase.storage
    .from(FACE_BUCKET)
    .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;

  const { error: updateError } = await supabase.from('admins').update({ face_reference_path: path }).eq('id', adminId);
  if (updateError) throw updateError;

  return res.status(200).json({ ok: true });
}

async function handleFaceStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const targetId = req.query.adminId || session.sub;
  if (targetId !== session.sub && session.role !== 'super_admin') {
    return res.status(403).json({ error: 'You can only check your own Face Recognition status.' });
  }

  const { data: admin, error } = await supabase
    .from('admins').select('face_reference_path, face_lock, failed_attempt_count').eq('id', targetId).maybeSingle();
  if (error) throw error;
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });

  return res.status(200).json({
    enrolled: !!admin.face_reference_path,
    faceLock: !!admin.face_lock,
    failedAttempts: admin.failed_attempt_count || 0,
  });
}

async function handleFaceStatusAll(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }

  const { data, error } = await supabase.from('admins').select('id, face_reference_path, face_lock, failed_attempt_count');
  if (error) throw error;

  const statuses = (data || []).map((a) => ({
    adminId: a.id,
    enrolled: !!a.face_reference_path,
    faceLock: !!a.face_lock,
    failedAttempts: a.failed_attempt_count || 0,
  }));
  return res.status(200).json({ statuses });
}

// Org Chart seat assignment — Super Admin (the "Board of Directors" seat)
// assigns each sub-admin a real title from the org chart. This is purely a
// label/identity layer on top of the existing, real permissions system —
// it does not itself grant or restrict access to anything. Kept in
// admin.js rather than admins.js so this stays self-contained.
// Single source of truth: the roles are the modules in Roles-dashboard.js/.
const ORG_TITLES = RoleDashboards.ROLE_TITLES;

// Each role has its OWN Telegram bot (its own token, its own webhook) —
// not one shared bot with topic threads. Env var names can't contain
// spaces/parens, so this maps each role to a safe key:
// TELEGRAM_BOT_TOKEN_<KEY> is the env var Hunter sets per bot.
const ROLE_ENV_KEYS = {
  'COO': 'COO', 'CTO': 'CTO', 'CFO': 'CFO', 'CMO': 'CMO', 'CLO': 'CLO', 'CHRO': 'CHRO', 'CAIO': 'CAIO',
  'CDO (Design)': 'CDO_DESIGN', 'CPO': 'CPO', 'CECO': 'CECO', 'CCO': 'CCO', 'CDO (Data)': 'CDO_DATA',
};
const ENV_KEY_TO_ROLE = Object.fromEntries(Object.entries(ROLE_ENV_KEYS).map(([role, key]) => [key, role]));

async function handleOrgTitlesAll(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data, error } = await supabase.from('admins').select('id, username, role, org_title');
  if (error) throw error;

  const titles = (data || []).map((a) => ({
    adminId: a.id,
    username: a.username,
    role: a.role,
    orgTitle: a.org_title || null,
  }));
  return res.status(200).json({ titles, availableTitles: ORG_TITLES, onePersonPerRole: RoleDashboards.ONE_PERSON_PER_ROLE });
}

async function handleOrgTitleSet(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only the Board of Directors (Super Admin) can assign seats.' });
  }

  const { adminId, orgTitle } = req.body || {};
  if (!adminId) {
    return res.status(400).json({ error: 'adminId is required.' });
  }
  if (orgTitle && !ORG_TITLES.includes(orgTitle)) {
    return res.status(400).json({ error: 'Unrecognized org title.' });
  }

  // A role is a seat: when one person per seat is enforced, a role that
  // someone else already holds is not vacant and can't be assigned.
  if (orgTitle && RoleDashboards.ONE_PERSON_PER_ROLE) {
    const { data: holders } = await supabase
      .from('admins')
      .select('username')
      .eq('org_title', orgTitle)
      .neq('id', adminId)
      .limit(1);
    if (holders && holders.length) {
      return res.status(409).json({ error: `${orgTitle} is already held by "${holders[0].username}". Choose a vacant role, or vacate that seat first.` });
    }
  }

  const { error } = await supabase.from('admins').update({ org_title: orgTitle || null }).eq('id', adminId);
  if (error) throw error;

  return res.status(200).json({ success: true });
}

/* ── Role actions: a form on a role page saves data through here. Only the
   holder of that seat (or Super Admin) may call the actions for that role. ── */
async function handleRoleAction(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data: admin } = await supabase
    .from('admins')
    .select('id, username, role, org_title, deactivated_at')
    .eq('id', session.sub)
    .maybeSingle();
  if (!admin || admin.deactivated_at) {
    return res.status(401).json({ error: 'This account has been deactivated.' });
  }

  const role = String(req.query.role || '');
  const name = String(req.query.name || '');
  if (admin.role !== 'super_admin' && admin.org_title !== role) {
    return res.status(403).json({ error: 'Only the holder of this role can do that.' });
  }

  try {
    const result = await RoleDashboards.act(role, name, {
      supabase, session, admin, env: process.env, getJSON, body: req.body || {},
    });
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    if (!err.status) console.error('role-action failed:', err && err.message);
    // Messages we wrote (with a status) are safe to show; anything else stays in the server log.
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save. Try again.' });
  }
}

/* ── Role dashboards ────────────────────────────────────────────────────
   Each seat has a page in Roles-dashboard.html/ and a backend module in
   Roles-dashboard.js/. A sub-admin can only load the dashboard for the seat
   they hold (looked up fresh from the DB, not from the token, so changing
   someone's role takes effect immediately). Super Admin can load any seat.
   The static HTML pages contain no data — everything comes through here. ── */
async function handleRoleDashboard(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data: admin } = await supabase
    .from('admins')
    .select('id, username, role, org_title, deactivated_at')
    .eq('id', session.sub)
    .maybeSingle();
  if (!admin || admin.deactivated_at) {
    return res.status(401).json({ error: 'This account has been deactivated.' });
  }

  const isSuper = admin.role === 'super_admin';
  const seat = admin.org_title || null;
  const requested = req.query.role ? String(req.query.role) : null;

  if (!isSuper && !seat) {
    return res.status(403).json({ error: 'You don\u2019t have a role yet. Ask the Board of Directors to assign you one.' });
  }

  const role = isSuper ? requested : seat;
  if (!role) return res.status(400).json({ error: 'role is required.' });
  if (!RoleDashboards.has(role)) return res.status(400).json({ error: 'Unrecognized role.' });

  if (!isSuper && requested && requested !== seat) {
    return res.status(403).json({
      error: `That is the ${requested} dashboard. Your role is ${seat}.`,
      dashboardPath: RoleDashboards.pathFor(seat),
    });
  }

  const result = await RoleDashboards.run(role, {
    supabase,
    session,
    admin,
    env: process.env,
    getJSON,
    integrationEnvVars: INTEGRATION_ENV_VARS,
  });

  return res.status(200).json({
    ...result,
    viewer: { username: admin.username, isSuperAdmin: isSuper },
    roles: isSuper ? RoleDashboards.listRoles() : undefined,
    generatedAt: new Date().toISOString(),
  });
}

/* ── Multi-role activation: each admin/sub-admin can have SEVERAL personas
   active simultaneously (not just one), each getting its own daily Cron
   brief and its own persisted conversation memory. Same permission rule as
   before: sub-admins can only activate "personal" or their own assigned
   org_title; Super Admin can activate any of the 12. ── */
async function assertRoleAllowed(session, roleTitle) {
  if (roleTitle === 'personal') return true;
  if (session.role === 'super_admin') return true;
  const { data } = await supabase.from('admins').select('org_title').eq('id', session.sub).maybeSingle();
  return !!(data && data.org_title === roleTitle);
}

async function handleToggleActiveRole(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { roleTitle, active } = req.body || {};
  if (!roleTitle || (roleTitle !== 'personal' && !ORG_TITLES.includes(roleTitle))) {
    return res.status(400).json({ error: 'Unrecognized role.' });
  }
  if (!(await assertRoleAllowed(session, roleTitle))) {
    return res.status(403).json({ error: 'You can only activate a role you actually hold.' });
  }

  if (active) {
    const { error } = await supabase.from('admin_active_roles').upsert(
      { admin_id: session.sub, role_title: roleTitle },
      { onConflict: 'admin_id,role_title', ignoreDuplicates: true }
    );
    if (error) throw error;
  } else {
    const { error } = await supabase.from('admin_active_roles').delete().eq('admin_id', session.sub).eq('role_title', roleTitle);
    if (error) throw error;
  }
  return res.status(200).json({ success: true });
}

async function handleActiveRolesList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { data, error } = await supabase.from('admin_active_roles').select('role_title').eq('admin_id', session.sub);
  if (error) throw error;
  return res.status(200).json({ activeRoles: (data || []).map((r) => r.role_title) });
}

/* ── Per-role persistent memory: each active persona remembers its OWN
   conversation, separately, across sessions and devices — not just
   whatever's in the browser tab. Scoped to admin_id + role_title. ── */
async function handleRoleMemoryList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const roleTitle = req.query.roleTitle || 'personal';
  const { data, error } = await supabase
    .from('admin_role_memory')
    .select('role, content, created_at')
    .eq('admin_id', session.sub)
    .eq('role_title', roleTitle)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return res.status(200).json({ messages: data || [] });
}

async function saveRoleMemoryTurn(adminId, roleTitle, userMessage, assistantReply) {
  try {
    await supabase.from('admin_role_memory').insert([
      { admin_id: adminId, role_title: roleTitle, role: 'user', content: userMessage },
      { admin_id: adminId, role_title: roleTitle, role: 'assistant', content: assistantReply },
    ]);
  } catch (err) {
    console.error('saveRoleMemoryTurn failed:', err.message);
  }
}

/* ── Notes/Reminders: the persistent-state piece behind Personal Assistant
   mode. Always scoped to the requesting admin's own id — no admin can see
   another admin's notes, including Super Admin (these are personal, not
   company data). ── */
async function handleNotesList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { data, error } = await supabase
    .from('admin_notes')
    .select('id, content, done, created_at')
    .eq('admin_id', session.sub)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ notes: data || [] });
}

async function handleNoteCreate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { content } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'content is required.' });
  }
  const { data, error } = await supabase
    .from('admin_notes')
    .insert({ admin_id: session.sub, content: content.trim() })
    .select('id, content, done, created_at')
    .single();
  if (error) throw error;
  return res.status(200).json({ note: data });
}

async function handleNoteUpdate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { id, done, content } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const updates = {};
  if (typeof done === 'boolean') updates.done = done;
  if (typeof content === 'string' && content.trim()) updates.content = content.trim();
  const { error } = await supabase.from('admin_notes').update(updates).eq('id', id).eq('admin_id', session.sub);
  if (error) throw error;
  return res.status(200).json({ success: true });
}

async function handleNoteDelete(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const { error } = await supabase.from('admin_notes').delete().eq('id', id).eq('admin_id', session.sub);
  if (error) throw error;
  return res.status(200).json({ success: true });
}

/* ── Theme Palettes: Super-Admin-managed color themes, assignable PER ROLE
   across both the Super Admin seat and every Sub Admin org-title seat (COO,
   CTO, CFO, ...). A palette isn't just "on" or "off" globally — the Super
   Admin picks which specific role(s) a given palette themes, so different
   seats can run different palettes (or share one) at the same time.

   'role_title' values used as keys throughout: the literal string
   'super_admin' for the Super Admin seat, or one of ORG_TITLES (COO, CTO,
   CFO, CMO, CLO, CHRO, CAIO, CDO (Design), CPO, CECO, CCO, CDO (Data)) for a
   Sub Admin seat. A role with no row / a null active_palette_id just means
   "use the built-in default theme".

   Only Super Admin can list/create/delete/assign palettes. Any
   authenticated admin (Super or Sub) can read the palette assigned to
   THEIR OWN role, via palette-active — that's what lets a Sub Admin's
   dashboard pick up whatever the Super Admin assigned to their seat.

   Requires these two Supabase tables (create once via the SQL editor):

     create table color_palettes (
       id uuid primary key default gen_random_uuid(),
       name text not null,
       colors jsonb not null,
       created_by text,
       created_at timestamptz not null default now()
     );

     create table admin_theme_assignments (
       role_title text primary key,
       active_palette_id uuid references color_palettes(id) on delete set null,
       updated_by text,
       updated_at timestamptz
     );

   NOTE: if you previously created a `store_theme_status` table for an
   earlier single-global-theme version of this feature, it's no longer used
   and can be dropped (or just left alone — nothing reads it anymore).
── */
const PALETTE_KEYS = ['gold', 'goldLight', 'goldDark', 'black', 'dark', 'dark2', 'bone', 'gray'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SUPER_ADMIN_ROLE_KEY = 'super_admin';
const PALETTE_ROLE_KEYS = [SUPER_ADMIN_ROLE_KEY, ...ORG_TITLES];

function sanitizePaletteColors(colors) {
  if (!colors || typeof colors !== 'object') return null;
  const clean = {};
  for (const key of PALETTE_KEYS) {
    const val = colors[key];
    if (typeof val !== 'string' || !HEX_COLOR_RE.test(val)) return null;
    clean[key] = val.toLowerCase();
  }
  return clean;
}

// Validates the "roles" array sent from the client against the known set
// (Super Admin + every org title), de-duplicated, in a stable order.
function sanitizePaletteRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) return null;
  const unique = [...new Set(roles)];
  if (unique.some((r) => !PALETTE_ROLE_KEYS.includes(r))) return null;
  return unique;
}

async function handlePaletteList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }
  const { data: palettes, error } = await supabase
    .from('color_palettes')
    .select('id, name, colors, created_by, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const { data: rows } = await supabase.from('admin_theme_assignments').select('role_title, active_palette_id');
  const assignments = {};
  (rows || []).forEach((r) => { assignments[r.role_title] = r.active_palette_id; });

  return res.status(200).json({ palettes: palettes || [], roles: PALETTE_ROLE_KEYS, assignments });
}

async function handlePaletteCreate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }
  const { name, colors } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'A palette name is required.' });
  }
  const clean = sanitizePaletteColors(colors);
  if (!clean) {
    return res.status(400).json({ error: 'colors must include valid 6-digit hex values for: ' + PALETTE_KEYS.join(', ') });
  }
  const { data, error } = await supabase
    .from('color_palettes')
    .insert({ name: name.trim().slice(0, 60), colors: clean, created_by: session.username || session.sub })
    .select('id, name, colors, created_by, created_at')
    .single();
  if (error) throw error;
  return res.status(200).json({ palette: data });
}

async function handlePaletteDelete(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });

  // Any role currently themed by this palette falls back to the default
  // theme rather than being left with a dangling reference.
  await supabase.from('admin_theme_assignments').update({
    active_palette_id: null, updated_by: session.username || session.sub, updated_at: new Date().toISOString(),
  }).eq('active_palette_id', id);

  const { error } = await supabase.from('color_palettes').delete().eq('id', id);
  if (error) throw error;
  return res.status(200).json({ success: true });
}

// Assigns one palette (or null, meaning "reset to default") to one or more
// roles at once — this is the "select sub admin role(s) to apply the
// palette to, plus an option for Super Admin" step.
async function handlePaletteActivate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin only.' });
  }
  const { id, roles } = req.body || {};

  const cleanRoles = sanitizePaletteRoles(roles);
  if (!cleanRoles) {
    return res.status(400).json({ error: 'Select at least one role (Super Admin and/or a Sub Admin role) to apply this to.' });
  }

  if (id) {
    const { data: palette, error: findError } = await supabase.from('color_palettes').select('id').eq('id', id).maybeSingle();
    if (findError) throw findError;
    if (!palette) return res.status(404).json({ error: 'Palette not found.' });
  }

  const now = new Date().toISOString();
  const rows = cleanRoles.map((roleTitle) => ({
    role_title: roleTitle, active_palette_id: id || null, updated_by: session.username || session.sub, updated_at: now,
  }));
  const { error } = await supabase.from('admin_theme_assignments').upsert(rows, { onConflict: 'role_title' });
  if (error) throw error;
  return res.status(200).json({ success: true, activePaletteId: id || null, roles: cleanRoles });
}

// Readable by ANY authenticated admin (Super or Sub) — resolves the
// requesting admin's OWN role_title and returns whatever palette the Super
// Admin assigned to that seat (or null for "use the default theme").
async function handleActivePalette(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  let roleTitle = SUPER_ADMIN_ROLE_KEY;
  if (session.role !== 'super_admin') {
    const { data: admin } = await supabase.from('admins').select('org_title').eq('id', session.sub).maybeSingle();
    if (!admin || !admin.org_title) return res.status(200).json({ palette: null });
    roleTitle = admin.org_title;
  }

  const { data: assignment } = await supabase
    .from('admin_theme_assignments')
    .select('active_palette_id')
    .eq('role_title', roleTitle)
    .maybeSingle();
  if (!assignment || !assignment.active_palette_id) {
    return res.status(200).json({ palette: null });
  }
  const { data: palette, error } = await supabase
    .from('color_palettes')
    .select('id, name, colors')
    .eq('id', assignment.active_palette_id)
    .maybeSingle();
  if (error) throw error;
  return res.status(200).json({ palette: palette || null });
}

/* ── Daily Cron brief: the genuine "works on its own" piece. Vercel Hobby
   caps cron at once/day, firing sometime within the scheduled hour — this
   is honest automation, not continuous monitoring. Triggered by Vercel's
   own cron scheduler via GET with an Authorization: Bearer <CRON_SECRET>
   header (auto-provisioned by Vercel), NOT an admin JWT — this bypasses
   requireAuth entirely and must check CRON_SECRET itself. ── */
/* ── Telegram: one SEPARATE bot per role (own token, own identity, own
   webhook), not shared topics. Setup (all manual, on Telegram's side):
     1. Message @BotFather, /newbot, once PER role you want — gives you a
        distinct token each time
     2. Set each as an env var: TELEGRAM_BOT_TOKEN_<KEY>  (see
        ROLE_ENV_KEYS above for the exact key per role, e.g. CMO, CTO,
        CDO_DESIGN, CDO_DATA)
     3. Register each bot's webhook to ITS OWN url (the ?role= query param
        is how one shared handler tells the roles apart):
        https://api.telegram.org/bot<TOKEN>/setWebhook?url=<domain>/api/admin?action=telegram-webhook%26role=<KEY>&secret_token=<TELEGRAM_WEBHOOK_SECRET>
     4. Open a chat with that bot in Telegram and send it any message —
        its chat_id is captured automatically the first time, no manual
        copying of thread IDs needed.
   "personal" is deliberately NOT reachable via Telegram — tied to one
   admin's own notes, no single company-wide bot makes sense for it. ── */

async function handleTelegramBotsStatus(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const { data: rows } = await supabase.from('telegram_role_bots').select('role_title, chat_id');
  const chatByRole = {};
  (rows || []).forEach((r) => { chatByRole[r.role_title] = r.chat_id; });

  const statuses = ORG_TITLES.map((role) => {
    const key = ROLE_ENV_KEYS[role];
    const hasToken = !!process.env[`TELEGRAM_BOT_TOKEN_${key}`];
    return {
      role,
      envKey: `TELEGRAM_BOT_TOKEN_${key}`,
      tokenConfigured: hasToken,
      chatConnected: !!chatByRole[role],
    };
  });
  return res.status(200).json({ statuses });
}

async function handleTelegramWebhook(req, res) {
  // Verify this really came from Telegram, not a random POST to a guessed URL.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (!secret || incomingSecret !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const roleKey = req.query.role;
  const roleTitle = ENV_KEY_TO_ROLE[roleKey];
  if (!roleTitle) {
    return res.status(200).json({ ok: true }); // unrecognized role key, ignore
  }

  const token = process.env[`TELEGRAM_BOT_TOKEN_${roleKey}`];
  if (!token) {
    return res.status(200).json({ ok: true }); // this role's bot isn't configured
  }

  const message = req.body?.message;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true }); // nothing to do, but ack so Telegram stops retrying
  }

  const chatId = message.chat.id;

  // First message this bot has ever received — auto-register its chat_id,
  // no manual thread-ID copying required.
  await supabase
    .from('telegram_role_bots')
    .upsert(
      { role_title: roleTitle, chat_id: chatId, first_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'role_title' }
    );

  try {
    const roleCtx = await buildRoleContext(roleTitle, { sub: null });

    const { data: memRows } = await supabase
      .from('telegram_role_memory')
      .select('role, content')
      .eq('role_title', roleTitle)
      .order('created_at', { ascending: true })
      .limit(30);

    const tools = getToolsForPersona(roleTitle);
    const systemInstruction = {
      parts: [{
        text:
          `You are ${roleCtx.promptRole}, reachable via your own dedicated Telegram bot for Razariser. ` +
          'Reply like a real chat message — short, direct, no headers or markdown formatting. ' +
          (tools ? 'You have access to real, live tools — use them for current data rather than guessing. ' : '') +
          'Grounded only in the real data below and whatever tools return; never invent data, statistics, or history not given to you.\n\n' + roleCtx.context,
      }],
    };
    const contents = [
      ...(memRows || []).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      { role: 'user', parts: [{ text: message.text }] },
    ];

    const reply = GEMINI_API_KEY
      ? await runGeminiWithTools(systemInstruction, contents, tools, { sub: null }, { feature: 'telegram-bot', persona: roleTitle })
      : 'No response generated.';

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });

    await supabase.from('telegram_role_memory').insert([
      { role_title: roleTitle, role: 'user', content: message.text },
      { role_title: roleTitle, role: 'assistant', content: reply },
    ]);
  } catch (err) {
    console.error('handleTelegramWebhook failed:', err.message);
  }

  return res.status(200).json({ ok: true });
}

async function handleCronDailyBrief(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const { data: activeRoles, error } = await supabase
    .from('admin_active_roles')
    .select('admin_id, role_title');
  if (error) throw error;

  const adminIds = [...new Set((activeRoles || []).map((r) => r.admin_id))];
  let usernameById = {};
  if (adminIds.length) {
    const { data: adminRows } = await supabase.from('admins').select('id, username').in('id', adminIds);
    (adminRows || []).forEach((a) => { usernameById[a.id] = a.username; });
  }

  const results = [];
  for (const row of activeRoles || []) {
    const adminId = row.admin_id;
    const roleTitle = row.role_title;
    const username = usernameById[adminId] || adminId;
    try {
      const roleCtx = await buildRoleContext(roleTitle, { sub: adminId });

      if (!GEMINI_API_KEY) continue;

      const systemInstruction = {
        parts: [{
          text:
            `You are operating as ${roleCtx.promptRole} inside the Razariser store's admin panel, writing a short, ` +
            'unprompted daily brief — 2-4 sentences, practical, no filler. Only reference real data given below; if ' +
            'there isn\'t much to report, say so plainly rather than padding it out.\n\n' + roleCtx.context,
        }],
      };
      const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: 'Give today\'s brief.' }] }] });
      if (!geminiRes.ok) { results.push({ admin: username, role: roleTitle, ok: false }); continue; }
      const data = await geminiRes.json();
      const brief = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';

      const roleKey = ROLE_ENV_KEYS[roleTitle];
      const token = roleKey ? process.env[`TELEGRAM_BOT_TOKEN_${roleKey}`] : null;
      const { data: botRow } = roleKey ? await supabase.from('telegram_role_bots').select('chat_id').eq('role_title', roleTitle).maybeSingle() : { data: null };
      if (token && botRow?.chat_id && brief) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: botRow.chat_id, text: `📋 Daily Brief — ${username}\n\n${brief}` }),
        });
      }
      if (brief) saveRoleMemoryTurn(adminId, roleTitle, '(daily brief)', brief);
      results.push({ admin: username, role: roleTitle, ok: true });
    } catch (err) {
      console.error('cron daily brief failed for', username, roleTitle, err.message);
      results.push({ admin: username, role: roleTitle, ok: false });
    }
  }

  const allOk = results.every((r) => r.ok);
  logAiUsage('cron-daily-brief', null, allOk, allOk ? null : 'one or more roles failed', null, null, null);

  return res.status(200).json({ processed: results.length, results });
}

/* ── Weekly Cron: auto-regenerate the Marketing Strategy and check pricing
   consistency, notify via the CMO's own Telegram bot if configured. Same
   CRON_SECRET auth pattern as the daily brief — bypasses requireAuth
   entirely, checked directly against the header Vercel sends. ── */
function checkCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  return !!cronSecret && authHeader === `Bearer ${cronSecret}`;
}

async function sendToRoleBot(roleTitle, text) {
  const key = ROLE_ENV_KEYS[roleTitle];
  if (!key) return;
  const token = process.env[`TELEGRAM_BOT_TOKEN_${key}`];
  if (!token) return;
  const { data: botRow } = await supabase.from('telegram_role_bots').select('chat_id').eq('role_title', roleTitle).maybeSingle();
  if (!botRow?.chat_id) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: botRow.chat_id, text }),
  }).catch((err) => console.error(`sendToRoleBot(${roleTitle}) failed:`, err.message));
}

async function sendToCmoBot(text) {
  return sendToRoleBot('CMO', text);
}

async function handleCronWeeklyStrategy(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });
  if (!GEMINI_API_KEY) return res.status(200).json({ skipped: true, reason: 'no Gemini key' });

  try {
    const context = await buildMarketingContext();
    const contextText = marketingContextToPromptText(context);
    const stageNote = context.orders.hasData
      ? `Razariser has ${context.orders.count} real orders — some revenue history exists to reason from.`
      : 'Razariser has ZERO orders so far. This is a pre-revenue stage. A real strategy for this stage prioritizes getting first sales and validating real demand — NOT scaling, retention loops, LTV optimization, or paid acquisition at volume. Say this plainly rather than writing generic growth-marketing advice.';

    const systemInstruction = {
      parts: [{
        text:
          'You are Razariser\'s Chief Marketing Officer (CMO) AI, writing a real marketing STRATEGY document. ' +
          `${stageNote} No ad platform or email/SMS provider is connected — do not recommend channels that don't ` +
          'actually exist yet as options. Be specific to the real product catalog and audience signals below. ' +
          'Never invent metrics, benchmarks, or industry statistics you weren\'t given.\n\n' +
          `Real current store context:\n${contextText}\n\n` +
          'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
          '{"stageAssessment": "...", "primaryObjective": "...", "targetAudience": "...", "positioning": "...", ' +
          '"priorities": [{"title": "...", "why": "...", "timeframe": "now or next or later"}], ' +
          '"channels": [{"channel": "...", "why": "...", "prerequisite": "null, or what needs to exist first"}], ' +
          '"phasedRoadmap": [{"phase": "...", "condition": "...", "focus": "..."}], ' +
          '"assumptions": ["..."]}',
      }],
    };
    const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: 'Generate the strategy.' }] }] });
    if (!geminiRes.ok) {
      logAiUsage('cron-weekly-strategy', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, null);
      return res.status(200).json({ ok: false, reason: `Gemini ${geminiRes.status}` });
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const strategy = JSON.parse(text.replace(/```json|```/g, '').trim());

    await supabase.from('marketing_strategy_versions').insert({ content: strategy });
    await sendToCmoBot(`📈 Weekly strategy refreshed.\n\nStage: ${strategy.stageAssessment}\n\nThis week's priority: ${strategy.primaryObjective}\n\nFull strategy in the panel's Marketing → Strategy tab.`);

    logAiUsage('cron-weekly-strategy', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('handleCronWeeklyStrategy failed:', err.message);
    logAiUsage('cron-weekly-strategy', 'CMO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

async function handleCronWeeklyPricingCheck(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const result = await TOOL_HANDLERS.checkPricingConsistency();
    if (!result.outliers || !result.outliers.length) {
      await sendToCmoBot('💰 Weekly pricing check: no outliers found — all products are consistent within their categories.');
      logAiUsage('cron-weekly-pricing-check', 'CMO', true, null, null, null, null);
      return res.status(200).json({ ok: true, outliers: 0 });
    }
    const lines = result.outliers.map((o) => `• ${o.product} (${o.category}): ₹${o.price}, ${o.direction} category avg ₹${o.categoryAverage}`);
    await sendToCmoBot(`💰 Weekly pricing check — ${result.outliers.length} outlier(s) found, worth a look (not necessarily wrong):\n\n${lines.join('\n')}`);
    logAiUsage('cron-weekly-pricing-check', 'CMO', true, null, null, null, null);
    return res.status(200).json({ ok: true, outliers: result.outliers.length });
  } catch (err) {
    console.error('handleCronWeeklyPricingCheck failed:', err.message);
    logAiUsage('cron-weekly-pricing-check', 'CMO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ── COO — Weekly Operations Check: real order fulfillment status. Honest
   when there's nothing to report (0 orders = 0 orders, not padded out). ── */
async function handleCronWeeklyOperations(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data: orders } = await supabase.from('orders').select('status, tracking_number, created_at').limit(2000);
    const rows = orders || [];
    if (!rows.length) {
      await sendToRoleBot('COO', '📦 Weekly Operations Check: 0 orders on record — nothing to report yet. This will get more useful once real orders start coming in.');
      logAiUsage('cron-weekly-operations', 'COO', true, null, null, null, null);
      return res.status(200).json({ ok: true, orders: 0 });
    }
    const byStatus = {};
    rows.forEach((o) => { byStatus[o.status || 'unknown'] = (byStatus[o.status || 'unknown'] || 0) + 1; });
    const staleThreshold = Date.now() - 5 * 86400000; // 5 days
    const stale = rows.filter((o) => !['delivered', 'cancelled', 'refunded'].includes(o.status) && new Date(o.created_at).getTime() < staleThreshold && !o.tracking_number);
    const statusLines = Object.entries(byStatus).map(([s, c]) => `• ${s}: ${c}`).join('\n');
    const staleLine = stale.length ? `\n\n⚠️ ${stale.length} order(s) older than 5 days with no tracking number yet — worth checking.` : '\n\n✓ No orders flagged as stuck.';
    await sendToRoleBot('COO', `📦 Weekly Operations Check\n\n${statusLines}${staleLine}`);
    logAiUsage('cron-weekly-operations', 'COO', true, null, null, null, null);
    return res.status(200).json({ ok: true, orders: rows.length, stale: stale.length });
  } catch (err) {
    console.error('handleCronWeeklyOperations failed:', err.message);
    logAiUsage('cron-weekly-operations', 'COO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ── CTO — Weekly System Health Check: real Vercel deployment status +
   real integration configuration state. ── */
async function handleCronWeeklySystemHealth(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const sysStatus = await TOOL_HANDLERS.getSystemStatus();
    const integrations = Object.entries(INTEGRATION_ENV_VARS).map(([key, def]) => ({
      key, label: def.label, configured: def.vars.every((v) => !!process.env[v]),
    }));
    const notConfigured = integrations.filter((i) => !i.configured);

    let deployLine = 'Vercel API not configured — no live deployment data available.';
    if (sysStatus.configured && sysStatus.recentDeployments?.length) {
      const latest = sysStatus.recentDeployments[0];
      deployLine = `Latest deployment: ${latest.state}, ${new Date(latest.createdAt).toLocaleString()}`;
      if (latest.state === 'ERROR') deployLine = `⚠️ ${deployLine} — most recent deployment FAILED.`;
    }
    const integrationsLine = notConfigured.length
      ? `⚠️ Not configured: ${notConfigured.map((i) => i.label).join(', ')}`
      : '✓ All integrations configured.';

    await sendToRoleBot('CTO', `🖥️ Weekly System Health Check\n\n${deployLine}\n\n${integrationsLine}`);
    logAiUsage('cron-weekly-system-health', 'CTO', true, null, null, null, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('handleCronWeeklySystemHealth failed:', err.message);
    logAiUsage('cron-weekly-system-health', 'CTO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ── CFO — Weekly Financial Summary: real revenue/order snapshot. ── */
async function handleCronWeeklyFinance(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const stats = await TOOL_HANDLERS.getOrderStats();
    const text = stats.totalOrders > 0
      ? `💵 Weekly Financial Summary\n\nTotal orders: ${stats.totalOrders}\nTotal revenue: ₹${stats.revenue.toLocaleString('en-IN')}`
      : `💵 Weekly Financial Summary\n\n0 orders on record so far — no revenue to report yet. Nothing invented to fill the gap.`;
    await sendToRoleBot('CFO', text);
    logAiUsage('cron-weekly-finance', 'CFO', true, null, null, null, null);
    return res.status(200).json({ ok: true, orders: stats.totalOrders });
  } catch (err) {
    console.error('handleCronWeeklyFinance failed:', err.message);
    logAiUsage('cron-weekly-finance', 'CFO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ── CHRO — Weekly Admin Security Check: real face-lock status and login
   activity across all admin accounts. Only genuinely "HR-adjacent" real
   data that exists in this system — admin accounts, not employees. ── */
async function handleCronWeeklyAdminSecurity(req, res) {
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data: admins } = await supabase.from('admins').select('username, face_lock, face_reference_path, failed_attempt_count');
    const rows = admins || [];
    const locked = rows.filter((a) => a.face_lock);
    const notEnrolled = rows.filter((a) => !a.face_reference_path);

    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: recentLogins } = await supabase.from('admin_logins').select('success').gte('created_at', since7d).limit(500);
    const failedLogins = (recentLogins || []).filter((l) => !l.success).length;

    const lines = [
      `Total admin accounts: ${rows.length}`,
      locked.length ? `⚠️ Currently face-locked: ${locked.map((a) => a.username).join(', ')}` : '✓ No accounts currently locked.',
      notEnrolled.length ? `Not yet enrolled in face recognition: ${notEnrolled.map((a) => a.username).join(', ')}` : '✓ All accounts have face recognition enrolled.',
      `Failed login attempts (7d): ${failedLogins}`,
    ];
    await sendToRoleBot('CHRO', `🔐 Weekly Admin Security Check\n\n${lines.join('\n')}`);
    logAiUsage('cron-weekly-admin-security', 'CHRO', true, null, null, null, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('handleCronWeeklyAdminSecurity failed:', err.message);
    logAiUsage('cron-weekly-admin-security', 'CHRO', false, err.message, null, null, null);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ── Marketing AI: real-data overview + AI Content Studio + campaign
   planner. No ad-platform, no local LLM, no competitor scraping, no
   forecasting — that infrastructure doesn't exist. This reuses the same
   Gemini call already used for the Assistant, grounded in real
   Supabase/GitHub data where it exists, and explicitly labeled empty where
   it doesn't (orders currently has 0 rows). ── */

async function buildMarketingContext() {
  const context = {
    products: { count: 0, byCategory: {}, sample: [] },
    customers: { count: 0 },
    pageViews: { count: 0, topPaths: [] },
    cartActivity: { count: 0 },
    wishlistActivity: { count: 0 },
    orders: { count: 0, revenue: 0, hasData: false },
  };

  try {
    const { data: products } = await getJSON('public/products.json');
    if (Array.isArray(products)) {
      context.products.count = products.length;
      products.forEach((p) => {
        const cat = p.catLabel || p.cat || 'Uncategorized';
        context.products.byCategory[cat] = (context.products.byCategory[cat] || 0) + 1;
      });
      context.products.sample = products.slice(0, 30).map((p) => ({
        name: p.name, category: p.catLabel || p.cat, price: p.price, badge: p.badge || null,
      }));
    }
  } catch (err) {
    console.error('marketing: products context failed:', err.message);
  }

  try {
    const { count } = await supabase.from('customers').select('*', { count: 'exact', head: true });
    context.customers.count = count || 0;
  } catch (err) {
    console.error('marketing: customers count failed:', err.message);
  }

  try {
    const { data: views, count } = await supabase.from('page_views').select('path', { count: 'exact' }).limit(2000);
    context.pageViews.count = count || 0;
    if (Array.isArray(views)) {
      const tally = {};
      views.forEach((v) => { if (v.path) tally[v.path] = (tally[v.path] || 0) + 1; });
      context.pageViews.topPaths = Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([path, n]) => ({ path, views: n }));
    }
  } catch (err) {
    console.error('marketing: page_views failed:', err.message);
  }

  try {
    const [{ count: c1 }, { count: c2 }] = await Promise.all([
      supabase.from('cart_items').select('*', { count: 'exact', head: true }),
      supabase.from('customer_cart_items').select('*', { count: 'exact', head: true }),
    ]);
    context.cartActivity.count = (c1 || 0) + (c2 || 0);
  } catch (err) {
    console.error('marketing: cart activity failed:', err.message);
  }

  try {
    const [{ count: w1 }, { count: w2 }] = await Promise.all([
      supabase.from('wishlist_items').select('*', { count: 'exact', head: true }),
      supabase.from('customer_wishlist_items').select('*', { count: 'exact', head: true }),
    ]);
    context.wishlistActivity.count = (w1 || 0) + (w2 || 0);
  } catch (err) {
    console.error('marketing: wishlist activity failed:', err.message);
  }

  try {
    const { data: orders, count } = await supabase.from('orders').select('amount, status').limit(5000);
    context.orders.count = count || (orders ? orders.length : 0);
    context.orders.hasData = context.orders.count > 0;
    if (Array.isArray(orders)) {
      context.orders.revenue = orders
        .filter((o) => o.status && o.status !== 'created' && o.status !== 'cancelled')
        .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    }
  } catch (err) {
    console.error('marketing: orders context failed:', err.message);
  }

  return context;
}

function marketingContextToPromptText(context) {
  const catLines = Object.entries(context.products.byCategory).map(([cat, n]) => `  - ${cat}: ${n}`).join('\n') || '  (none)';
  const topPathLines = context.pageViews.topPaths.map((p) => `  - ${p.path}: ${p.views} views`).join('\n') || '  (no page view data)';
  return [
    `Products: ${context.products.count} total.`,
    `By category:\n${catLines}`,
    `Customers: ${context.customers.count} registered.`,
    `Page views: ${context.pageViews.count} total. Top pages:\n${topPathLines}`,
    `Active cart items right now: ${context.cartActivity.count}.`,
    `Active wishlist items right now: ${context.wishlistActivity.count}.`,
    context.orders.hasData
      ? `Orders: ${context.orders.count} total, ₹${context.orders.revenue.toLocaleString('en-IN')} revenue (non-cancelled, non-pending).`
      : `Orders: NONE YET — Razariser has no completed sales history. Do not invent conversion rates, revenue figures, CAC, LTV, or forecasts. State plainly that these require real order data once sales start.`,
  ].join('\n');
}

async function handleMarketingOverview(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  const context = await buildMarketingContext();
  return res.status(200).json({ context });
}

// Proactive analysis — this is the "notices things and tells you" behavior,
// not another chat box waiting for a question. Still grounded only in real
// data: with 3 customers and 0 orders, it's told explicitly to flag low
// sample size rather than pretend to see confident patterns in noise.
async function handleMarketingBrief(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  const context = await buildMarketingContext();
  const contextText = marketingContextToPromptText(context);

  const systemInstruction = {
    parts: [{
      text:
        'You are Razariser\'s Chief Marketing Officer (CMO) AI — the role covers Brand, Marketing, Performance, Social Media, Influencers, and Campaigns per Razariser\'s org chart. Razariser is a premium men\'s pre-order fashion brand. You are writing ' +
        'an unprompted brief for the admin — the kind of thing a sharp marketing director would notice and flag ' +
        'without being asked, the moment they looked at the real numbers below. ' +
        'Rules: only point out things actually supported by the data below — category imbalances, dead pages, ' +
        'cart/wishlist activity with no matching purchases, catalog gaps. If the sample size is too small to draw ' +
        'a real conclusion (e.g. only a few customers, zero orders), SAY SO explicitly rather than inventing a ' +
        'confident pattern from noise — "too early to tell" is a valid and honest finding. Do not invent revenue, ' +
        'conversion rates, or trends that aren\'t in the data. Keep each point to one or two sentences, practical, ' +
        'no filler.\n\n' +
        `Real current store data:\n${contextText}\n\n` +
        'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
        '{"headline": "one short sentence framing the overall state right now", ' +
        '"points": [{"title": "short label", "detail": "1-2 sentences", "severity": "info or opportunity or watch"}], ' +
        '"tooEarlyFor": ["list of things there genuinely is not enough data for yet, e.g. forecasting, LTV, churn"]}. ' +
        'Give 3 to 6 points, ranked most important first.',
    }],
  };

  const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: 'Generate today\'s brief.' }] }] });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('marketing-brief: Gemini API error:', geminiRes.status, errText);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }

  const data = await geminiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let brief;
  try {
    brief = JSON.parse(cleaned);
  } catch (err) {
    console.error('marketing-brief: failed to parse JSON:', err.message, cleaned);
    return res.status(502).json({ error: 'AI returned an unexpected format. Try again.' });
  }

  return res.status(200).json({ brief });
}

// Real forecasting engine — gated on sample size rather than faked. Below
// the threshold it returns exactly that: how many more orders are needed
// before a forecast is statistically meaningful. Once there's enough
// history, this computes an actual trend from actual order timestamps —
// no AI guessing involved, this part is arithmetic.
const FORECAST_MIN_ORDERS = 10;

async function handleMarketingForecast(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  let orders = [];
  try {
    const { data } = await supabase
      .from('orders')
      .select('amount, status, created_at')
      .not('status', 'in', '("created","cancelled")')
      .order('created_at', { ascending: true })
      .limit(5000);
    orders = data || [];
  } catch (err) {
    console.error('marketing-forecast: orders query failed:', err.message);
    return res.status(500).json({ error: 'Could not load order history.' });
  }

  if (orders.length < FORECAST_MIN_ORDERS) {
    return res.status(200).json({
      ready: false,
      currentOrders: orders.length,
      minRequired: FORECAST_MIN_ORDERS,
      message: `Forecasting needs at least ${FORECAST_MIN_ORDERS} completed orders to be statistically meaningful. You have ${orders.length} right now. This isn't a fixed wait — it just activates automatically the moment you cross that line.`,
    });
  }

  // Real math: bucket by day, compare trailing 14-day average order value
  // and daily order rate against the 14 days before that. No AI involved.
  const now = Date.now();
  const dayMs = 86400000;
  const recentWindow = orders.filter((o) => now - new Date(o.created_at).getTime() <= 14 * dayMs);
  const priorWindow = orders.filter((o) => {
    const age = now - new Date(o.created_at).getTime();
    return age > 14 * dayMs && age <= 28 * dayMs;
  });

  const sum = (arr) => arr.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const recentRevenue = sum(recentWindow);
  const priorRevenue = sum(priorWindow);
  const recentDailyOrders = recentWindow.length / 14;
  const priorDailyOrders = priorWindow.length / 14;
  const revenueTrendPct = priorRevenue > 0 ? Math.round(((recentRevenue - priorRevenue) / priorRevenue) * 100) : null;
  const projectedNext14DayRevenue = Math.round(recentDailyOrders * 14 * (recentWindow.length ? recentRevenue / recentWindow.length : 0));

  return res.status(200).json({
    ready: true,
    totalOrders: orders.length,
    recentRevenue,
    priorRevenue,
    revenueTrendPct,
    recentDailyOrderRate: Math.round(recentDailyOrders * 100) / 100,
    projectedNext14DayRevenue,
    note: 'Simple trailing-window trend from your real order history — not an AI guess. Treat as directional, especially with a small order count.',
  });
}

async function handleBrandVoiceCheck(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required.' });
  }

  const systemInstruction = {
    parts: [{
      text:
        'You are Razariser\'s Chief Marketing Officer (CMO) AI, checking a piece of copy against Razariser\'s real ' +
        'brand voice: confident, premium, understated — specific and concrete rather than generic superlatives; ' +
        'shows quality through detail rather than just claiming "premium" or "amazing"; never uses fake urgency, ' +
        'fabricated statistics, or fake scarcity. Review the text the admin pasted. Be honest and specific — if it ' +
        'drifts from this voice, say exactly where and why, don\'t just praise it.\n\n' +
        'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
        '{"onBrand": true or false, "issues": ["specific issue with a specific fix, or empty array if none"], "revisedVersion": "a revised version if there were issues, otherwise the original text unchanged"}',
    }],
  };

  const startTime = Date.now();
  const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text }] }] });
  if (!geminiRes.ok) {
    logAiUsage('brand-voice-check', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, Date.now() - startTime);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }
  const data = await geminiRes.json();
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (err) {
    logAiUsage('brand-voice-check', 'CMO', false, 'parse error', data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
    return res.status(502).json({ error: 'AI returned an unexpected format. Try again.' });
  }
  logAiUsage('brand-voice-check', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
  return res.status(200).json(result);
}

async function handleMarketingContent(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  const { contentType, brief, productName, tone } = req.body || {};
  if (!contentType || !brief) {
    return res.status(400).json({ error: 'contentType and brief are required.' });
  }

  const context = await buildMarketingContext();
  const contextText = marketingContextToPromptText(context);

  const CONTENT_TYPE_LABELS = {
    product_description: 'a product description',
    instagram_caption: 'an Instagram caption (with relevant hashtags)',
    email_campaign: 'a marketing email (subject line + body)',
    ad_copy: 'short paid ad copy (headline + body, suitable for Meta or Google Ads)',
    blog_article: 'a short blog article',
    sms: 'a concise SMS marketing message (under 160 characters)',
    push_notification: 'a push notification (title + short body)',
    headline: 'a set of 5 punchy headline options',
    abandoned_cart: 'an abandoned cart nudge (email or SMS, admin will specify which in the brief)',
    wishlist_reminder: 'a wishlist reminder message (email or push, admin will specify which in the brief)',
  };
  const TONE_LABELS = {
    punchy: 'Punchy and energetic',
    elegant: 'Elegant and understated',
    urgent: 'Urgent, scarcity-driven (but honest — no fake countdowns or fake stock claims)',
    minimal: 'Minimal, few words, let the product speak',
  };
  const typeLabel = CONTENT_TYPE_LABELS[contentType] || 'marketing copy';
  const toneLabel = TONE_LABELS[tone] || 'Confident, premium, understated (Razariser\'s default voice)';

  const FRAMEWORK_GUIDANCE = {
    product_description: 'Lead with the strongest concrete benefit, not a feature list. Use sensory, specific language (fabric feel, fit, occasion) over generic adjectives like "amazing" or "premium" used alone — show premium, don\'t just claim it.',
    instagram_caption: 'Hook in the first line — it\'s what shows before "more." Use AIDA (Attention, Interest, Desire, Action): open with a scroll-stopping line, build interest with one concrete detail, create desire by painting the moment of wearing it, end with a clear next step.',
    email_campaign: 'Subject line under 50 characters, curiosity or benefit-driven, no spammy words (FREE, !!!, ALL CAPS). Body: one clear goal per email, PAS structure (Problem the reader has, Agitate briefly, Solution = the product), one clear call to action, not three.',
    ad_copy: 'Headline states the core benefit in under 6 words if possible. Body uses PAS or a direct offer structure. Every claim must be something the reader can verify by looking at the product — no vague superiority claims.',
    blog_article: 'Open with a concrete scenario or question the reader recognizes, not a generic definition. Structure: hook, 2-3 substantive points with specifics, a clear takeaway — no filler paragraphs.',
    sms: 'Front-load the single most important word. No fluff, no greeting. Under 160 characters including any link placeholder.',
    push_notification: 'Title creates curiosity or urgency in 3-5 words. Body completes the thought, doesn\'t repeat the title.',
    headline: 'Each of the 5 should test a genuinely different angle: benefit-led, curiosity-led, social-proof-led (only if real proof exists), urgency-led (honest, no fake scarcity), and identity-led (who this is for).',
    abandoned_cart: 'One clear reason to come back — remind, don\'t guilt-trip. No fake urgency ("only 2 left!") unless it\'s real. A single clear link/action, not a wall of upsells.',
    wishlist_reminder: 'Light touch, not a hard sell — this person already showed interest, the job is a gentle nudge, not pressure. Reference the act of saving it, not a fabricated reason it\'s special now.',
  };

  const systemInstruction = {
    parts: [{
      text:
        'You are the AI Content Studio, operating under Razariser\'s Chief Marketing Officer (CMO) AI, inside the Razariser store\'s admin panel. ' +
        'You write with the judgment of an experienced direct-response and brand copywriter — not generic AI marketing filler. ' +
        'Razariser is a premium men\'s fashion brand (T-shirts, cargo pants, joggers, co-ords) sold via pre-order, ' +
        'with a black-and-gold premium aesthetic. ' +
        `Tone for this piece: ${toneLabel}. ` +
        `Craft guidance for this content type: ${FRAMEWORK_GUIDANCE[contentType] || 'Be specific and concrete over generic; state real benefits, not empty adjectives.'} ` +
        `Generate THREE distinct variants of ${typeLabel} based on the admin's brief — genuinely different angles or hooks ` +
        '(not reworded copies of each other; vary the opening line, the emotional angle, or the structural approach between variants). ' +
        'These are DRAFTS for the admin to review and edit — never claim they have been published or sent anywhere. ' +
        'Do not invent specific statistics, discount percentages, review counts, or claims not given to you — specificity should come from real product detail, never from fabricated numbers. ' +
        'If the brief references a specific product, use the real product context below if it matches.\n\n' +
        `Real current store context:\n${contextText}\n\n` +
        'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
        '{"variants": ["variant 1 full text", "variant 2 full text", "variant 3 full text"]}',
    }],
  };

  const userText = productName ? `Product: ${productName}\n\nBrief: ${brief}` : `Brief: ${brief}`;

  const startTime = Date.now();
  const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: userText }] }] });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('marketing-content: Gemini API error:', geminiRes.status, errText);
    logAiUsage('content-studio', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, Date.now() - startTime);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }

  const data = await geminiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let variants;
  try {
    const parsed = JSON.parse(cleaned);
    variants = Array.isArray(parsed.variants) ? parsed.variants : [text];
  } catch (err) {
    // Fall back to treating the whole reply as one variant rather than
    // failing outright — still useful, just not split into 3.
    variants = [text || 'No content generated.'];
  }
  logAiUsage('content-studio', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);

  // Log every generation for the Content Log — the honest version of
  // "performance tracking" available here: a real historical record the
  // admin can mark as published and annotate with actual outcomes, since
  // there's no ad platform or click-attribution data to automate this with.
  let logIds = [];
  try {
    const { data: inserted } = await supabase
      .from('marketing_content_log')
      .insert(variants.map((v) => ({ content_type: contentType, brief, variant_text: v })))
      .select('id');
    logIds = (inserted || []).map((r) => r.id);
  } catch (err) {
    console.error('marketing-content: content log insert failed:', err.message);
  }

  return res.status(200).json({ variants, logIds });
}

/* ── Content Log: the honest version of "performance tracking" — a real
   history of every generated piece, which the admin can mark as actually
   published and annotate with real outcomes they observed. Not automated
   attribution (no click/ad-platform data exists to automate it with). ── */
async function handleContentLogList(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { data, error } = await supabase
    .from('marketing_content_log')
    .select('id, content_type, brief, variant_text, published, published_at, outcome_note, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return res.status(200).json({ entries: data || [] });
}

async function handleContentLogUpdate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { id, published, outcomeNote } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const updates = {};
  if (typeof published === 'boolean') {
    updates.published = published;
    updates.published_at = published ? new Date().toISOString() : null;
  }
  if (typeof outcomeNote === 'string') updates.outcome_note = outcomeNote;
  const { error } = await supabase.from('marketing_content_log').update(updates).eq('id', id);
  if (error) throw error;
  return res.status(200).json({ success: true });
}

async function handleMarketingCampaign(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  const { campaignType, goal, notes } = req.body || {};
  if (!campaignType || !goal) {
    return res.status(400).json({ error: 'campaignType and goal are required.' });
  }

  const context = await buildMarketingContext();
  const contextText = marketingContextToPromptText(context);

  const systemInstruction = {
    parts: [{
      text:
        'You are Razariser\'s Chief Marketing Officer (CMO) AI. Draft a campaign ' +
        'PLAN — this is never auto-published or auto-scheduled, it is a proposal for the admin to review and ' +
        'execute manually. Apply real strategic marketing principles: a campaign needs ONE primary objective, not ' +
        'several competing ones; the target audience should be specific enough to actually write to (not "everyone ' +
        'who likes fashion"); channels should match where that specific audience actually spends attention, not a ' +
        'generic list; content ideas should connect directly to the objective, not be a random assortment. ' +
        'Base it on the real store context below. Razariser has no ad platform, email/SMS provider, ' +
        'or historical campaign data connected yet, so any reach/conversion/ROI figures you give MUST be clearly ' +
        'labeled as rough, directional, illustrative estimates only — never presented as measured or guaranteed. ' +
        'If order history is empty, say so plainly rather than inventing a conversion rate.\n\n' +
        `Real current store context:\n${contextText}\n\n` +
        'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
        '{"name": "...", "objective": "...", "durationSuggestion": "...", "targetAudience": "...", ' +
        '"channels": ["..."], "contentIdeas": ["...", "..."], "estimateNote": "one sentence, clearly caveated as illustrative", "steps": ["...", "..."]}',
    }],
  };

  const userText = `Campaign type: ${campaignType}\nGoal: ${goal}${notes ? `\nAdditional notes: ${notes}` : ''}`;

  const startTime = Date.now();
  const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: userText }] }] });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('marketing-campaign: Gemini API error:', geminiRes.status, errText);
    logAiUsage('campaign-planner', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, Date.now() - startTime);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }

  const data = await geminiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch (err) {
    console.error('marketing-campaign: failed to parse JSON:', err.message, cleaned);
    logAiUsage('campaign-planner', 'CMO', false, 'parse error', data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
    return res.status(502).json({ error: 'AI returned an unexpected format. Try again.' });
  }

  logAiUsage('campaign-planner', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
  return res.status(200).json({ plan });
}

/* ── Marketing Strategy: a persistent, comprehensive strategic document —
   not a single campaign, not a daily brief. Synthesizes all real available
   data into a stage-appropriate direction. Explicitly reasons about
   Razariser's ACTUAL current stage (0 orders = pre-revenue) rather than
   generating generic "scale your funnel" advice that wouldn't apply yet. ── */
async function handleMarketingStrategyGenerate(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }

  const context = await buildMarketingContext();
  const contextText = marketingContextToPromptText(context);

  const stageNote = context.orders.hasData
    ? `Razariser has ${context.orders.count} real orders — some revenue history exists to reason from.`
    : 'Razariser has ZERO orders so far. This is a pre-revenue stage. A real strategy for this stage prioritizes getting first sales and validating real demand — NOT scaling, retention loops, LTV optimization, or paid acquisition at volume. Say this plainly in the strategy rather than writing generic growth-marketing advice that assumes a functioning funnel.';

  const systemInstruction = {
    parts: [{
      text:
        'You are Razariser\'s Chief Marketing Officer (CMO) AI, writing a real marketing STRATEGY document — not a ' +
        'single campaign, not a daily note. This is meant to be a living reference the admin returns to, synthesizing ' +
        'everything real about the business into a coherent, honestly stage-appropriate direction. ' +
        `${stageNote} ` +
        'No ad platform or email/SMS provider is connected — do not recommend channels that don\'t actually exist yet ' +
        'as options; if you recommend connecting one, say that\'s a prerequisite, not something already usable. ' +
        'Be specific to Razariser\'s real product catalog and real audience signals below, not generic fashion-brand ' +
        'advice that could apply to anyone. Never invent metrics, benchmarks, or industry statistics you weren\'t given.\n\n' +
        `Real current store context:\n${contextText}\n\n` +
        'Respond with ONLY raw JSON, no markdown, no code fences, in exactly this shape: ' +
        '{"stageAssessment": "1-2 sentences, honest about where the business actually is right now", ' +
        '"primaryObjective": "the ONE thing that matters most right now, given the real stage", ' +
        '"targetAudience": "specific, grounded in the real product catalog — not generic", ' +
        '"positioning": "1-2 sentences on how Razariser should be positioned given its real catalog and pricing", ' +
        '"priorities": [{"title": "...", "why": "...", "timeframe": "now or next or later"}], ' +
        '"channels": [{"channel": "...", "why": "...", "prerequisite": "null, or what needs to exist first"}], ' +
        '"phasedRoadmap": [{"phase": "Phase 1 name", "condition": "what real threshold triggers moving to this phase", "focus": "..."}], ' +
        '"assumptions": ["explicit list of what this strategy assumes, so it\'s clear what would change it"]}',
    }],
  };

  const startTime = Date.now();
  const geminiRes = await fetchGeminiWithRetry({ system_instruction: systemInstruction, contents: [{ role: 'user', parts: [{ text: 'Generate the strategy.' }] }] });
  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('marketing-strategy: Gemini API error:', geminiRes.status, errText);
    logAiUsage('strategy-generate', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, Date.now() - startTime);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }

  const data = await geminiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let strategy;
  try {
    strategy = JSON.parse(cleaned);
  } catch (err) {
    console.error('marketing-strategy: failed to parse JSON:', err.message, cleaned);
    logAiUsage('strategy-generate', 'CMO', false, 'parse error', data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
    return res.status(502).json({ error: 'AI returned an unexpected format. Try again.' });
  }

  logAiUsage('strategy-generate', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);

  const { data: saved, error } = await supabase
    .from('marketing_strategy_versions')
    .insert({ content: strategy })
    .select('id, created_at')
    .single();
  if (error) console.error('marketing-strategy: save failed:', error.message);

  return res.status(200).json({ strategy, id: saved?.id, createdAt: saved?.created_at });
}

async function handleMarketingStrategyLatest(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { data, error } = await supabase
    .from('marketing_strategy_versions')
    .select('id, content, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(200).json({ strategy: null });
  return res.status(200).json({ strategy: data.content, id: data.id, createdAt: data.created_at });
}

async function handleMarketingStrategyHistory(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  const { data, error } = await supabase
    .from('marketing_strategy_versions')
    .select('id, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return res.status(200).json({ versions: data || [] });
}

/* ── Market Research: real web search, via Gemini's google_search grounding
   tool — actual current information from the live internet, with real
   source links, not the model's training-data guesses. Kept as a SEPARATE
   endpoint from the chat/tool-calling system: Gemini does not support
   combining search grounding with custom function-calling tools in the
   same request, so this deliberately doesn't try to. Scoped to general
   market/trend/best-practice research — not scraping or deep-profiling any
   specific named competitor. ── */
async function handleMarketingResearch(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel environment variables.' });
  }
  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required.' });
  }

  const systemInstruction = {
    parts: [{
      text:
        'You are Razariser\'s Chief Marketing Officer (CMO) AI doing real market research using live web search. ' +
        'Razariser is a premium men\'s pre-order fashion brand (T-shirts, cargo pants, joggers, co-ords). ' +
        'Answer the admin\'s research question using real, current search results. Be concise and practical — ' +
        'pull out what actually matters for a small premium menswear brand, not a generic essay. ' +
        'Stay at the level of general trends, public best practices, and public market information — do not ' +
        'attempt to deeply profile or scrape data about a specific named competitor business.',
    }],
  };

  const body = {
    system_instruction: systemInstruction,
    contents: [{ role: 'user', parts: [{ text: question }] }],
    tools: [{ google_search: {} }],
  };

  const startTime = Date.now();
  const geminiRes = await fetchGeminiWithRetry(body);
  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('marketing-research: Gemini API error:', geminiRes.status, errText);
    logAiUsage('market-research', 'CMO', false, `Gemini ${geminiRes.status}`, null, null, Date.now() - startTime);
    return res.status(502).json({ error: `AI service error (${geminiRes.status}). Try again in a moment.` });
  }

  const data = await geminiRes.json();
  const candidate = data.candidates?.[0];
  const answer = candidate?.content?.parts?.map((p) => p.text || '').join('') || 'No response generated.';

  const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = groundingChunks
    .map((c) => c.web ? { title: c.web.title, uri: c.web.uri } : null)
    .filter(Boolean);
  const searchQueries = candidate?.groundingMetadata?.webSearchQueries || [];

  logAiUsage('market-research', 'CMO', true, null, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, Date.now() - startTime);
  return res.status(200).json({ answer, sources, searchQueries });
}

/* ── AI Control Center: the real version of what was asked for. Covers
   what actually exists (Gemini-based personas, real automations, real
   Telegram bots) — no GPU monitor, no NVIDIA model cards, no fake hardware
   data, since none of that infrastructure exists on this stack. ── */

const GEMINI_PRICE_PER_M_INPUT = 0.10; // USD, gemini-2.5-flash-lite, confirmed current as of this build
const GEMINI_PRICE_PER_M_OUTPUT = 0.40;

async function handleAiControlOverview(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin only.' });

  const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data: logs30d } = await supabase
    .from('ai_usage_logs')
    .select('feature, persona, success, tokens_in, tokens_out, latency_ms, created_at')
    .gte('created_at', since30d)
    .limit(5000);

  const rows = logs30d || [];
  const rows7d = rows.filter((r) => r.created_at >= since7d);

  const summarize = (set) => {
    const total = set.length;
    const successes = set.filter((r) => r.success).length;
    const tokensIn = set.reduce((s, r) => s + (r.tokens_in || 0), 0);
    const tokensOut = set.reduce((s, r) => s + (r.tokens_out || 0), 0);
    const avgLatency = total ? Math.round(set.reduce((s, r) => s + (r.latency_ms || 0), 0) / total) : 0;
    const estCost = (tokensIn / 1e6) * GEMINI_PRICE_PER_M_INPUT + (tokensOut / 1e6) * GEMINI_PRICE_PER_M_OUTPUT;
    return { total, successRate: total ? Math.round((successes / total) * 100) : null, tokensIn, tokensOut, avgLatencyMs: avgLatency, estimatedCostUsd: Math.round(estCost * 10000) / 10000 };
  };

  const byFeature = {};
  rows.forEach((r) => { byFeature[r.feature] = (byFeature[r.feature] || 0) + 1; });
  const byPersona = {};
  rows.forEach((r) => { if (r.persona) byPersona[r.persona] = (byPersona[r.persona] || 0) + 1; });

  return res.status(200).json({
    last7Days: summarize(rows7d),
    last30Days: summarize(rows),
    requestsByFeature: Object.entries(byFeature).map(([feature, count]) => ({ feature, count })).sort((a, b) => b.count - a.count),
    requestsByPersona: Object.entries(byPersona).map(([persona, count]) => ({ persona, count })).sort((a, b) => b.count - a.count),
    provider: 'Google Gemini (gemini-2.5-flash-lite)',
    note: 'gemini-2.5-flash-lite is scheduled for retirement by Google on 2026-10-16 — will need a model-string update before then.',
  });
}

async function handleAiControlAgents(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin only.' });

  const since30d = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: logs } = await supabase.from('ai_usage_logs').select('persona, success, created_at').gte('created_at', since30d).limit(5000);
  const { data: activeRoleRows } = await supabase.from('admin_active_roles').select('role_title');
  const activeSet = new Set((activeRoleRows || []).map((r) => r.role_title));
  const { data: telegramRows } = await supabase.from('telegram_role_bots').select('role_title, chat_id');
  const telegramConnected = new Set((telegramRows || []).filter((r) => r.chat_id).map((r) => r.role_title));

  const allPersonas = ['personal', ...ORG_TITLES];
  const agents = allPersonas.map((p) => {
    const relevant = (logs || []).filter((l) => l.persona === p);
    const lastExec = relevant.length ? relevant.reduce((latest, r) => (r.created_at > latest ? r.created_at : latest), relevant[0].created_at) : null;
    const successCount = relevant.filter((r) => r.success).length;
    return {
      persona: p,
      activeInPanel: p === 'personal' ? null : activeSet.has(p),
      telegramConnected: p === 'personal' ? false : telegramConnected.has(p),
      requestsLast30d: relevant.length,
      successRate: relevant.length ? Math.round((successCount / relevant.length) * 100) : null,
      lastExecution: lastExec,
      hasTools: p === 'personal' ? true : !!ROLE_TOOL_NAMES[p],
    };
  });

  return res.status(200).json({ agents });
}

async function handleAiControlLogs(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin only.' });

  const { data, error } = await supabase
    .from('ai_usage_logs')
    .select('feature, persona, success, error_message, tokens_in, tokens_out, latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return res.status(200).json({ logs: data || [] });
}

async function handleAiControlHealth(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (session.role !== 'super_admin') return res.status(403).json({ error: 'Super Admin only.' });

  const checks = [];

  checks.push({ name: 'Gemini API key', status: GEMINI_API_KEY ? 'healthy' : 'offline', detail: GEMINI_API_KEY ? 'Configured' : 'GEMINI_API_KEY not set' });

  try {
    const { error } = await supabase.from('admins').select('id', { count: 'exact', head: true });
    checks.push({ name: 'Database', status: error ? 'offline' : 'healthy', detail: error ? error.message : 'Reachable' });
  } catch (err) {
    checks.push({ name: 'Database', status: 'offline', detail: err.message });
  }

  const { data: telegramRows } = await supabase.from('telegram_role_bots').select('role_title, chat_id');
  const connectedBots = (telegramRows || []).filter((r) => r.chat_id).length;
  checks.push({ name: 'Telegram bots', status: connectedBots > 0 ? 'healthy' : 'warning', detail: `${connectedBots} of 12 role bots connected` });

  const since2d = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: recentCronLogs } = await supabase.from('ai_usage_logs').select('feature, success, created_at').like('feature', 'cron-%').gte('created_at', since2d).order('created_at', { ascending: false }).limit(20);
  const cronRan = (recentCronLogs || []).length > 0;
  checks.push({ name: 'Cron automations', status: cronRan ? 'healthy' : 'warning', detail: cronRan ? `Last ran ${recentCronLogs[0].created_at}` : 'No cron activity logged in the last 2 days — check vercel.json is deployed with the cron entries' });

  checks.push({ name: 'NVIDIA / GPU', status: 'offline', detail: 'Not connected — no NVIDIA integration or GPU hardware exists in this deployment' });

  return res.status(200).json({ checks });
}

// ── Project Tree ───────────────────────────────────────────────────────────
// Returns the full folder/file map of the GitHub repo (the source of truth for
// this project) as a flat list; the admin panel builds the tree from it.
// Same access rule as the System tab: Super Admin or the CTO seat. Read-only.
async function handleProjectTree(req, res) {
  const session = requireAuth(req, res);
  if (!session) return;
  if (!(await hasOrgTitleAccess(session, ['CTO']))) {
    return res.status(403).json({ error: 'Restricted to Super Admin or the CTO seat.' });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    return res.status(200).json({
      configured: false,
      message: 'Add GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in Vercel env vars to enable the project tree.',
    });
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'admin-project-tree',
  };

  const ghError = (what, status) => {
    const hint =
      status === 401 ? 'GITHUB_TOKEN is invalid or expired.' :
      status === 403 ? 'GitHub refused the request (token lacks permission, or the API rate limit was hit).' :
      status === 404 ? 'not found — check GITHUB_OWNER / GITHUB_REPO, that the token can read this repo, and the branch name.' :
      status === 409 ? 'the repository is empty.' : 'unexpected GitHub response.';
    return `${what} failed (${status}): ${hint}`;
  };
  const enc = (path) => path.split('/').map(encodeURIComponent).join('/'); // keeps "/" in branch names

  // Branch: ?branch=... > GITHUB_BRANCH env > the repo's default branch.
  let branch = String(req.query.branch || process.env.GITHUB_BRANCH || '').trim();
  if (branch && !/^[\w.\-\/]+$/.test(branch)) {
    return res.status(400).json({ error: 'Invalid branch name.' });
  }
  if (!branch) {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders });
    if (!repoRes.ok) return res.status(502).json({ error: ghError('GitHub repo lookup', repoRes.status) });
    branch = (await repoRes.json()).default_branch || 'main';
  }

  // Resolve the branch to its tree SHA first. The branches endpoint accepts
  // names containing "/" (e.g. feature/x), which the trees endpoint does not
  // reliably accept when given a branch name directly.
  const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${enc(branch)}`, { headers: ghHeaders });
  if (!branchRes.ok) {
    return res.status(502).json({ error: ghError(`Branch "${branch}" lookup`, branchRes.status) });
  }
  const treeSha = (await branchRes.json())?.commit?.commit?.tree?.sha;
  if (!treeSha) return res.status(502).json({ error: `Could not read the tree for branch "${branch}".` });

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    { headers: ghHeaders }
  );
  if (!treeRes.ok) {
    return res.status(502).json({ error: ghError('GitHub tree fetch', treeRes.status) });
  }
  const tree = await treeRes.json();

  const items = (tree.tree || [])
    .filter((n) => n.type === 'blob' || n.type === 'tree')
    .map((n) => ({ path: n.path, type: n.type === 'tree' ? 'dir' : 'file', size: n.size || 0 }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    configured: true,
    repo: `${owner}/${repo}`,
    branch,
    truncated: !!tree.truncated,
    items,
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  try {
    if (req.method === 'POST' && action === 'login') return await handleLogin(req, res);
    if (req.method === 'POST' && action === 'update-location') return await handleUpdateLocation(req, res);
    if (req.method === 'GET' && action === 'terms-status') return await handleTermsStatus(req, res);
    if (req.method === 'POST' && action === 'terms-accept') return await handleTermsAccept(req, res);
    if (req.method === 'GET' && action === 'dashboard') return await handleDashboard(req, res);
    if (req.method === 'GET' && action === 'login-logs') return await handleLoginLogs(req, res);
    if (req.method === 'POST' && action === 'assistant') return await handleAssistant(req, res);
    if (req.method === 'GET' && action === 'system-status') return await handleSystemStatus(req, res);
    if (req.method === 'GET' && action === 'project-tree') return await handleProjectTree(req, res);
    if (req.method === 'GET' && action === 'integrations-status') return await handleIntegrationsStatus(req, res);
    if (req.method === 'GET' && action === 'maintenance-status') return await handleMaintenanceStatus(req, res);
    if (req.method === 'GET' && action === 'maintenance-public-status') return await handleMaintenancePublicStatus(req, res);
    if (req.method === 'POST' && action === 'maintenance-toggle') return await handleMaintenanceToggle(req, res);
    if (req.method === 'POST' && action === 'maintenance-extend') return await handleMaintenanceExtend(req, res);
    if (req.method === 'GET' && action === 'maintenance-history') return await handleMaintenanceHistory(req, res);
    if (req.method === 'POST' && action === 'maintenance-webhook') return await handleMaintenanceTelegramWebhook(req, res);
    if (req.method === 'POST' && action === 'face-challenge-verify') return await handleFaceChallengeVerify(req, res);
    if (req.method === 'POST' && action === 'face-enroll-self') return await handleFaceEnrollSelf(req, res);
    if (req.method === 'POST' && action === 'face-enroll-for-admin') return await handleFaceEnrollForAdmin(req, res);
    if (req.method === 'GET' && action === 'face-status') return await handleFaceStatus(req, res);
    if (req.method === 'GET' && action === 'face-status-all') return await handleFaceStatusAll(req, res);
    if (req.method === 'GET' && action === 'org-titles-all') return await handleOrgTitlesAll(req, res);
    if (req.method === 'POST' && action === 'set-org-title') return await handleOrgTitleSet(req, res);
    if (req.method === 'GET' && action === 'role-dashboard') return await handleRoleDashboard(req, res);
    if (req.method === 'POST' && action === 'role-action') return await handleRoleAction(req, res);
    if (req.method === 'GET' && action === 'marketing-overview') return await handleMarketingOverview(req, res);
    if (req.method === 'GET' && action === 'marketing-brief') return await handleMarketingBrief(req, res);
    if (req.method === 'GET' && action === 'marketing-forecast') return await handleMarketingForecast(req, res);
    if (req.method === 'POST' && action === 'marketing-content') return await handleMarketingContent(req, res);
    if (req.method === 'POST' && action === 'marketing-campaign') return await handleMarketingCampaign(req, res);
    if (req.method === 'POST' && action === 'marketing-strategy-generate') return await handleMarketingStrategyGenerate(req, res);
    if (req.method === 'GET' && action === 'marketing-strategy-latest') return await handleMarketingStrategyLatest(req, res);
    if (req.method === 'GET' && action === 'marketing-strategy-history') return await handleMarketingStrategyHistory(req, res);
    if (req.method === 'POST' && action === 'marketing-research') return await handleMarketingResearch(req, res);
    if (req.method === 'POST' && action === 'brand-voice-check') return await handleBrandVoiceCheck(req, res);
    if (req.method === 'GET' && action === 'content-log-list') return await handleContentLogList(req, res);
    if (req.method === 'POST' && action === 'content-log-update') return await handleContentLogUpdate(req, res);
    if (req.method === 'POST' && action === 'toggle-active-role') return await handleToggleActiveRole(req, res);
    if (req.method === 'GET' && action === 'active-roles') return await handleActiveRolesList(req, res);
    if (req.method === 'GET' && action === 'role-memory') return await handleRoleMemoryList(req, res);
    if (req.method === 'GET' && action === 'telegram-bots-status') return await handleTelegramBotsStatus(req, res);
    if (req.method === 'POST' && action === 'telegram-webhook') return await handleTelegramWebhook(req, res);
    if (req.method === 'GET' && action === 'notes-list') return await handleNotesList(req, res);
    if (req.method === 'POST' && action === 'notes-create') return await handleNoteCreate(req, res);
    if (req.method === 'POST' && action === 'notes-update') return await handleNoteUpdate(req, res);
    if (req.method === 'POST' && action === 'notes-delete') return await handleNoteDelete(req, res);
    if (req.method === 'GET' && action === 'palette-list') return await handlePaletteList(req, res);
    if (req.method === 'POST' && action === 'palette-create') return await handlePaletteCreate(req, res);
    if (req.method === 'POST' && action === 'palette-delete') return await handlePaletteDelete(req, res);
    if (req.method === 'POST' && action === 'palette-activate') return await handlePaletteActivate(req, res);
    if (req.method === 'GET' && action === 'palette-active') return await handleActivePalette(req, res);
    if (req.method === 'GET' && action === 'cron-daily-brief') return await handleCronDailyBrief(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-strategy') return await handleCronWeeklyStrategy(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-pricing-check') return await handleCronWeeklyPricingCheck(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-operations') return await handleCronWeeklyOperations(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-system-health') return await handleCronWeeklySystemHealth(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-finance') return await handleCronWeeklyFinance(req, res);
    if (req.method === 'GET' && action === 'cron-weekly-admin-security') return await handleCronWeeklyAdminSecurity(req, res);
    if (req.method === 'GET' && action === 'ai-control-overview') return await handleAiControlOverview(req, res);
    if (req.method === 'GET' && action === 'ai-control-agents') return await handleAiControlAgents(req, res);
    if (req.method === 'GET' && action === 'ai-control-logs') return await handleAiControlLogs(req, res);
    if (req.method === 'GET' && action === 'ai-control-health') return await handleAiControlHealth(req, res);

    // Finance / Inventory / Returns Command Centers
    if (req.method === 'GET' && action === 'finance-overview') return await handleFinanceOverview(req, res);
    if (req.method === 'POST' && action === 'expense-create') return await handleExpenseCreate(req, res);
    if (req.method === 'POST' && action === 'expense-delete') return await handleExpenseDelete(req, res);
    if (req.method === 'GET' && action === 'inventory-overview') return await handleInventoryOverview(req, res);
    if (req.method === 'POST' && action === 'warehouse-create') return await handleWarehouseCreate(req, res);
    if (req.method === 'POST' && action === 'stock-adjust') return await handleStockAdjust(req, res);
    if (req.method === 'GET' && action === 'returns-list') return await handleReturnsList(req, res);
    if (req.method === 'POST' && action === 'return-update-status') return await handleReturnUpdateStatus(req, res);
    if (req.method === 'GET' && action === 'analytics-overview') return await handleAnalyticsOverview(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('admin.js error:', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
};
