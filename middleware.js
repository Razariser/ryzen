// Vercel Edge Middleware — runs on every request to the storefront BEFORE
// it's served, and swaps in maintenance.html while maintenance mode is on.
//
// What it deliberately does NOT touch (see `matcher` below), so the admin
// can always get back in to turn it back off:
//   - /api/*            (all serverless functions, including the admin API)
//   - /admin.html        (the admin panel itself)
//   - /maintenance.html   (the backup page itself — excluding this avoids
//                          the middleware recursively intercepting its own
//                          fetch of this file, below)
//   - /src/*, static assets, favicon, robots.txt, sitemap.xml
//
// How it decides: calls the PUBLIC, no-auth
// /api/admin?action=maintenance-public-status endpoint (added alongside
// this file — see admin.js) on every matched request. If maintenance is on,
// it fetches maintenance.html and returns that content directly (same URL
// in the browser, HTTP 503) instead of letting the real page through.
//
// Fails OPEN: if the status check itself errors out (network blip, cold
// start, etc.), the real site is served rather than trapping every visitor
// in maintenance mode because of an unrelated hiccup.
//
// Deploy: drop this file at your project ROOT (same level as index.html
// and the /api folder) alongside maintenance.html, then redeploy.

export const config = {
  matcher: [
    '/((?!api|admin\\.html|maintenance\\.html|src|assets|favicon\\.ico|robots\\.txt|sitemap\\.xml|_vercel).*)',
  ],
};

export default async function middleware(request) {
  const url = new URL(request.url);

  try {
    const statusRes = await fetch(`${url.origin}/api/admin?action=maintenance-public-status`, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!statusRes.ok) return; // fail open — let the real site through

    const data = await statusRes.json();
    if (!data || !data.on) return; // maintenance is off — let the real site through

    const pageRes = await fetch(`${url.origin}/maintenance.html`);
    const html = await pageRes.text();

    return new Response(html, {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': '120',
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return; // fail open on any error — never let a broken check take the site down
  }
}
