const { test, expect } = require('@playwright/test');

const API = process.env.API_URL; // same Vercel deployment as the storefront + admin panel

// ---- Storefront (Vite app at /) -------------------------------------------
test('storefront loads without script errors @storefront', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const res = await page.goto('./');
  expect(res.status()).toBeLessThan(400);
  expect(errors).toEqual([]);
});

test('storefront images all load @storefront', async ({ page }) => {
  await page.goto('./', { waitUntil: 'networkidle' });
  const broken = await page.$$eval('img', (imgs) =>
    imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src)
  );
  expect(broken).toEqual([]);
});

// ---- Admin panel ------------------------------------------------------------
test('admin panel loads @admin', async ({ page }) => {
  const res = await page.goto('./admin.html');
  expect(res.status()).toBeLessThan(400);
});

test('CTO dashboard redirects signed-out visitors @admin', async ({ page }) => {
  await page.goto('./Roles-dashboard.html/CTO.html');
  await page.waitForURL(/admin\.html/, { timeout: 5000 });
});

// ---- Backend API --------------------------------------------------------
test('admin actions reject anonymous calls @api', async ({ request }) => {
  const res = await request.get(`${API}/api/admin?action=qa-sessions`);
  expect(res.status()).toBe(401);
});

test('qa-report rejects a wrong secret @api', async ({ request }) => {
  const res = await request.post(`${API}/api/admin?action=qa-report`, {
    data: { session_id: 'test' },
    headers: { 'x-pw-secret': 'wrong' },
  });
  expect(res.status()).toBe(401);
});

test('unknown action returns 400, not a crash @api', async ({ request }) => {
  const res = await request.get(`${API}/api/admin?action=not-a-real-action`);
  expect(res.status()).toBe(400);
});

// Add real flows below (cart, coupon, checkout, admin login) and tag each
// with @storefront, @admin or @api so the suite picker on the dashboard
// can target them.
