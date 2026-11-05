// Click counter for AskColin (askcolin.uk) — Netlify Functions 2.0, NO npm dependencies.
// Talks to Netlify Blobs over HTTPS with fetch, so the site deploys by drag-and-drop (no build, no GitHub).
//   POST {t, g, p}  — from askcolin.uk (proxied via /api/clicks). t = type, g = target, p = page path.
//   GET  ?key=...&days=30 — totals for /dashboard/. Requires TRACK_KEY env var to match.
// Storage design (append-only, so no conditional writes are needed):
//   every click writes one tiny blob  ev/YYYY-MM-DD/<random>  = {t,g,p}
//   the dashboard GET folds those into one document per day  day/YYYY-MM-DD  and deletes the events.
// No cookies, no IPs, no personal data: only counts per day, per target and per page.

const TYPES = new Set(['briefing', 'training', 'check', 'download', 'cta', 'pricing', 'email', 'phone']);
const MAX_KEYS = 400;
const STORE = 'site:clicks';
const ymd = (d) => d.toISOString().slice(0, 10);
const env = (k) => { try { return Netlify.env.get(k) || process.env[k] || ''; } catch { return process.env[k] || ''; } };
const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });

// ---- Blobs transport -------------------------------------------------------------------------
// Preferred: the NETLIFY_BLOBS_CONTEXT the runtime gives every function (edge URL + short-lived token).
// Fallback: the public API with a personal access token (NETLIFY_TOKEN) and the site id (SITE_ID).
let CTX = null;
function blobsContext(siteFromRequest) {
  if (CTX) return CTX;
  try {
    const raw = env('NETLIFY_BLOBS_CONTEXT');
    if (raw) {
      const c = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      if (c && c.token && c.siteID && (c.edgeURL || c.uncachedEdgeURL)) {
        CTX = { mode: 'edge', token: c.token, siteID: c.siteID, read: (c.uncachedEdgeURL || c.edgeURL), write: (c.edgeURL || c.uncachedEdgeURL) };
        return CTX;
      }
    }
  } catch (e) { /* fall through */ }
  const token = env('NETLIFY_TOKEN'), siteID = env('SITE_ID') || siteFromRequest || '';
  if (token && siteID) { CTX = { mode: 'api', token, siteID, read: 'https://api.netlify.com/api/v1/blobs', write: 'https://api.netlify.com/api/v1/blobs' }; return CTX; }
  throw new Error('no blobs credentials (NETLIFY_BLOBS_CONTEXT missing and NETLIFY_TOKEN/SITE_ID not set)');
}
const auth = (c) => ({ Authorization: 'Bearer ' + c.token });
const keyURL = (c, base, key) => `${base}/${c.siteID}/${STORE}/${encodeURIComponent(key)}`;

// The API answers with { url } (a signed URL to use for the real transfer); the edge serves the blob directly.
async function resolve(c, base, key, method) {
  const u = keyURL(c, base, key);
  if (c.mode === 'edge') return { url: u, headers: auth(c) };
  const r = await fetch(u, { method, headers: auth(c) });
  if (!r.ok) throw new Error(`api ${method} ${key} -> ${r.status}`);
  const j = await r.json();
  if (!j || !j.url) throw new Error('api gave no url');
  return { url: j.url, headers: {} };
}
async function getJSON(c, key) {
  const { url, headers } = await resolve(c, c.read, key, 'GET');
  const r = await fetch(url, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get ${key} -> ${r.status}`);
  try { return await r.json(); } catch { return null; }
}
async function putJSON(c, key, obj) {
  const { url, headers } = await resolve(c, c.write, key, 'PUT');
  const r = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error(`put ${key} -> ${r.status}`);
}
async function del(c, key) {
  const { url, headers } = await resolve(c, c.write, key, 'DELETE');
  const r = await fetch(url, { method: 'DELETE', headers });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${key} -> ${r.status}`);
}
async function list(c, prefix) {
  const keys = []; let cursor = '';
  for (let page = 0; page < 50; page++) {
    const u = `${c.read}/${c.siteID}/${STORE}?prefix=${encodeURIComponent(prefix)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const r = await fetch(u, { headers: auth(c) });
    if (!r.ok) throw new Error(`list ${prefix} -> ${r.status}`);
    const j = await r.json();
    for (const b of (j.blobs || [])) if (b && b.key) keys.push(b.key);
    cursor = j.next_cursor || '';
    if (!cursor) break;
  }
  return keys;
}

// ---- Aggregation --------------------------------------------------------------------------------
const emptyDoc = () => ({ total: 0, types: {}, pages: {} });
function addEvent(doc, t, g, p) {
  doc.total += 1;
  doc.types[t] = doc.types[t] || { n: 0, targets: {} };
  doc.types[t].n += 1;
  const tg = doc.types[t].targets;
  if (tg[g] !== undefined || Object.keys(tg).length < MAX_KEYS) tg[g] = (tg[g] || 0) + 1;
  if (doc.pages[p] !== undefined || Object.keys(doc.pages).length < MAX_KEYS) doc.pages[p] = (doc.pages[p] || 0) + 1;
}
function merge(into, doc) {
  into.total += doc.total || 0;
  for (const [t, v] of Object.entries(doc.types || {})) {
    into.types[t] = into.types[t] || { n: 0, targets: {} };
    into.types[t].n += v.n || 0;
    for (const [g, n] of Object.entries(v.targets || {})) into.types[t].targets[g] = (into.types[t].targets[g] || 0) + n;
  }
  for (const [p, n] of Object.entries(doc.pages || {})) into.pages[p] = (into.pages[p] || 0) + n;
}
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

// Fold the loose event blobs of one day into its day document, then delete them.
async function compact(c, date) {
  const evKeys = await list(c, `ev/${date}/`);
  const doc = (await getJSON(c, `day/${date}`)) || emptyDoc();
  if (!evKeys.length) return doc;
  const events = await Promise.all(evKeys.map(k => getJSON(c, k).catch(() => null)));
  const good = [];
  events.forEach((e, i) => { if (e && TYPES.has(e.t)) { addEvent(doc, e.t, String(e.g || ''), String(e.p || '')); good.push(evKeys[i]); } });
  await putJSON(c, `day/${date}`, doc);
  for (let i = 0; i < good.length; i += 20) await Promise.all(good.slice(i, i + 20).map(k => del(c, k).catch(() => null)));
  return doc;
}

export default async (req, context) => {
  try {
    const siteFromRequest = (context && context.site && context.site.id) || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type' } });

    if (req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await req.text() || '{}'); } catch { return text(400, 'bad json'); }
      const t = String(b.t || ''); const g = String(b.g || '').slice(0, 160); const p = String(b.p || '').slice(0, 160);
      if (!TYPES.has(t) || !p) return text(400, 'bad event');
      const c = blobsContext(siteFromRequest);
      const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      await putJSON(c, `ev/${ymd(new Date())}/${id}`, { t, g, p });
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const want = env('TRACK_KEY');
      if (!want || url.searchParams.get('key') !== want) return text(401, 'unauthorised');
      const c = blobsContext(siteFromRequest);
      if (url.searchParams.get('debug')) {
        const probe = { mode: c.mode, siteID: c.siteID };
        try { probe.todayEvents = (await list(c, `ev/${ymd(new Date())}/`)).length; } catch (e) { probe.listError = String(e.message || e); }
        return new Response(JSON.stringify(probe), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
      const dates = [];
      for (let i = days - 1; i >= 0; i--) dates.push(ymd(new Date(Date.now() - i * 86400000)));
      // Only the last 3 days can still have loose events worth folding; older days are read as-is.
      const docs = await Promise.all(dates.map((d, idx) => (idx >= dates.length - 3 ? compact(c, d) : getJSON(c, `day/${d}`)).catch(() => null)));
      const out = { days: [], totals: emptyDoc() };
      dates.forEach((date, idx) => {
        const doc = docs[idx] || emptyDoc();
        const row = { date, total: doc.total || 0 };
        for (const t of TYPES) row[t] = ((doc.types || {})[t] || {}).n || 0;
        out.days.push(row);
        merge(out.totals, doc);
      });
      const tg = (t, n) => top(((out.totals.types[t] || {}).targets) || {}, n);
      const summary = {
        days: out.days, total: out.totals.total,
        byType: Object.fromEntries(Object.entries(out.totals.types).map(([t, v]) => [t, v.n])),
        briefing: tg('briefing', 40), training: tg('training', 40), check: tg('check', 20),
        download: tg('download', 20), cta: tg('cta', 20), pricing: tg('pricing', 10),
        email: tg('email', 10), phone: tg('phone', 10),
        topPages: top(out.totals.pages, 30)
      };
      return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    return text(405, 'method');
  } catch (e) {
    console.error('track error', e);
    return text(500, 'error: ' + (e && e.message ? e.message : String(e)));
  }
};

export const config = { path: '/api/clicks' };
