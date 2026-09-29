const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, { method = 'GET', body, prefer = 'return=representation' } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const safeEq = (a = '', b = '') => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ADMIN AUTH: the one place to adapt to your panel's session format.
// Expects "Authorization: Bearer <HS256 JWT>" signed with ADMIN_JWT_SECRET.
// Returns the token payload, or null.
function requireAdmin(req) {
  const secret = process.env.ADMIN_JWT_SECRET;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [h, p, s] = token.split('.');
  if (!secret || !h || !p || !s) return null;
  const good = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (!safeEq(s, good)) return null;
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

async function notify(text) {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) return;
  await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: c, text })
  }).catch(() => {});
}

const send = (res, code, data) => res.status(code).json(data);

module.exports = { sb, safeEq, requireAdmin, notify, send };
