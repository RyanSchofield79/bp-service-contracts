// board-gate.js — lock a Business Pilot dashboard so ONLY the TVW staff bot can reach it.
// The bot's proxy (dashproxy.mjs) fetches each board with the header  x-tvw-proxy: <PROXY_SECRET>.
// A direct public browser hit can't set that header, so it's blocked. No DNS, no cookies, no paid features.
//
// Deploy to EACH dashboard repo:
//   - put this ONE file at  netlify/edge-functions/board-gate.js  (nothing else needed:
//     the `export const config = { path: "/*" }` below auto-registers it — no netlify.toml edit).
//   - set env var PROXY_SECRET to the SAME value on the bot and every board.
//
// Fails closed: if PROXY_SECRET is unset, or the header is missing/wrong, the board is blocked.

export default async (request, context) => {
  const secret = Deno.env.get("PROXY_SECRET");
  const sent = request.headers.get("x-tvw-proxy");
  if (!secret || sent !== secret) {
    return new Response(
      "This dashboard is only available through the TVW staff hub. Open it from the hub after signing in.",
      { status: 403, headers: { "content-type": "text/plain" } }
    );
  }
  return context.next();
};

export const config = { path: "/*" };
