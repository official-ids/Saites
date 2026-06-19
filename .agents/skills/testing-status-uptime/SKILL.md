---
name: testing-status-uptime
description: Test the /status server-side uptime monitoring (persisted history + 24h/7d/30d uptime). Use when verifying /status, /api/status-history, or /api/status-check changes.
---

# Testing /status server-side uptime monitoring

The Saites backend is a single Express app exported from `api/proxy.js` (runs as a
Vercel serverless function in prod). `/status` used to compute uptime from in-browser
history; it now reads server-persisted snapshots from Vercel KV via
`/api/status-history` and `/api/status-check`. 

## Why you usually must test locally
The Vercel **preview** deployment is typically behind Deployment Protection and returns
HTTP 401 to unauthenticated requests/browsers, so you generally cannot browser-test the
preview directly. Test the real code locally instead — the persistence/aggregation logic
is identical; only the KV backend differs. (If the user disables protection or provides a
bypass token, you could test the live preview.)

## Running the app locally with a mocked KV
There is no real KV/Blob/VAPID locally, so mock `@vercel/kv` and provide a dummy
`ADMIN_TOKEN` (required: `downloader.js` throws without it; other missing env vars only warn).

Harness pattern (see a working copy used during testing at `/home/ubuntu/status_test/run.js`
if still present; otherwise recreate):
- Override `Module._load` to return an in-memory `{ kv }` for `require('@vercel/kv')`.
  Implement at least: `get/set/del/mget/keys/incr/expire` and set helpers
  `smembers/sadd/srem/sismember` and hash helpers `hget/hset/hgetall/hdel` (news.js,
  support.js, redirects.js use these at load/runtime).
- Seed `status:history` (array of snapshots) and `status:last_check` (ms timestamp).
- `require('/home/ubuntu/Saites/api/proxy.js')` then `app.listen(PORT)`.
- Run with: `ADMIN_TOKEN=dummy PORT=3000 node run.js`. Page is at `http://localhost:3000/status/`
  (note trailing slash; `/status` 301-redirects).

Gotcha: routes you add to `app` AFTER requiring proxy.js never match, because proxy.js
registers a catch-all 404 during module load. Control test scenarios via the seed/env
(e.g. a `SEED_STALE` flag that sets `status:last_check` in the past) and observe state via
console logging, not via added HTTP routes.

## Snapshot shape and aggregation
```js
{ timestamp, status, operational, total, avgLatency,
  services: { [id]: { status, latency, statusCode, error } } }
```
Uptime % for a window = (snapshots in window with status==='operational') / (snapshots in window),
rounded to 0.1. Per-service uses `services[id].status`. Windows: 24h / 7d / 30d.

## Deterministic test (makes broken vs working visibly different)
Seed snapshots across the three windows with known operational/outage counts so each window
yields a distinct, hand-computed %. Frontend color thresholds (`formatUptimeValue`):
green >= 99, yellow 95-99, red < 95. Pick seeds that produce one of each color, e.g.
24h=100.0% (green), 7d=96.7% (yellow), 30d=90.0% (red). Verify the API first:
`curl -s localhost:3000/api/status-history | ...` should return those exact numbers.

Key assertions on the page:
1. The 24h/7d/30d tiles show the exact seeded %s with the matching colors.
2. Source line reads `Снимков: N · последняя запись: ...` (proves N server snapshots, not session).
3. Per-service cards show `X% за 30 дней` matching seeded per-service data.
4. Persistence: press F5 — values and `Снимков: N` stay identical (old in-memory code reset).
5. Server recording: seed `status:last_check` stale, visit `/status` — `/api/status-history`
   records a new snapshot in the background; on a follow-up reload `Снимков` goes N -> N+1 and
   `last_check` advances. (Note: the first stale visit returns the old count and triggers the
   record async; the increment shows on the next load.)

## Notes
- The header bar % is computed from only the visible snapshots in the bar, so it can differ
  slightly from the 30d window — don't treat that as a bug.
- External services (Telegram/GitHub) may show degraded/Connection failed from the local box;
  that's environment, not a regression.

## Devin Secrets Needed
None for local mocked testing (a dummy `ADMIN_TOKEN` is enough). To test the live Vercel
preview you'd need Deployment Protection disabled or a Vercel bypass token.
