import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

// One function serves both the voting API and the shared film list.
export const config = { path: ["/api/votes", "/api/films"] };

const LANGS = ["ta", "te", "ml", "kn", "hi", "en"];
const NAMES = { ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", hi: "Hindi", en: "Hollywood" };
// Tamil keeps the original key names so earlier votes and films stay put.
const keys = (lang) => {
  const p = lang === "ta" ? "" : lang + "-";
  return { vote: p + "v-", totals: p + "totals", films: p + "films" };
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_FILMS = 1000;      // total user-added films kept
const PER_DEVICE_DAY = 5;    // adds per device per day
const PER_IP_DAY = 15;       // adds per network per day

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tidy = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 60);
const json = (d, status = 200) => Response.json(d, { status, headers: { "Cache-Control": "no-store" } });
const err = (m, status = 400) => json({ ok: false, error: m }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = () => getStore({ name: "votes", consistency: "strong" });
const today = () => new Date().toISOString().slice(0, 10);
const hash = (s) => createHash("sha256").update("tc26:" + s).digest("hex").slice(0, 16);

// Read-modify-write that retries if someone else wrote in between,
// so two people voting at the same moment can't erase each other's vote.
async function update(s, key, fn, init) {
  for (let i = 0; i < 25; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : init();
    const out = fn(data);
    if (out === undefined) return data; // nothing to change
    const res = cur && cur.etag
      ? await s.setJSON(key, out, { onlyIfMatch: cur.etag })
      : await s.setJSON(key, out, { onlyIfNew: true });
    if (res.modified) return out;
    await sleep(Math.random() * Math.min(1000, 30 * (i + 1)));
  }
  throw new Error("busy");
}

const cleanList = (a) => {
  if (!Array.isArray(a)) return [];
  const seen = new Set(), out = [];
  for (const x of a.slice(0, 10)) {
    if (typeof x !== "string") continue;
    const t = tidy(x), k = norm(t);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
};
const bump = (o, arr, d) => {
  for (const t of arr || []) {
    const k = norm(t);
    if (!k) continue;
    const e = o[k] || { t, c: 0 };
    e.c += d;
    if (d > 0) e.t = t;
    if (e.c > 0) o[k] = e; else delete o[k];
  }
};
const emptyTotals = () => ({ n: 0, best: {}, worst: {} });
const emptyFilms = () => ({ films: [], hidden: [] });

// Builds totals from every saved vote. Used once to pick up votes made
// before running totals existed, and from the admin page as a repair.
async function recount(s, K, onlyIfMissing) {
  const t = emptyTotals();
  for await (const page of s.list({ prefix: K.vote, paginate: true })) {
    for (const b of page.blobs) {
      const v = await s.get(b.key, { type: "json" });
      if (!v) continue;
      t.n++; bump(t.best, v.best, 1); bump(t.worst, v.worst, 1);
    }
  }
  if (onlyIfMissing) {
    const res = await s.setJSON(K.totals, t, { onlyIfNew: true });
    if (!res.modified) return await s.get(K.totals, { type: "json" });
  } else await s.setJSON(K.totals, t);
  return t;
}
async function totals(s, K) {
  return (await s.get(K.totals, { type: "json" })) || (await recount(s, K, true));
}

function isAdmin(req) {
  const want = process.env.ADMIN_KEY || "";
  const got = req.headers.get("x-admin-key") || "";
  if (want.length < 8 || !got) return false;
  const a = Buffer.from(hash(want)), b = Buffer.from(hash(got));
  return timingSafeEqual(a, b);
}

async function votes(req, s, K) {
  if (req.method === "GET") {
    const [t, fs] = await Promise.all([
      totals(s, K),
      Promise.all((K.all ? LANGS.map(keys) : [K]).map((k) => s.get(k.films, { type: "json" }))),
    ]);
    const hidden = new Set();
    for (const f of fs) for (const h of (f && f.hidden) || []) {
      hidden.add(h);
      if (K.all) for (const l of LANGS) hidden.add(h + " " + norm(NAMES[l]));
    }
    const top = (o) => Object.entries(o)
      .filter(([k]) => !hidden.has(k))
      .map(([, v]) => v)
      .sort((a, b) => b.c - a.c || a.t.localeCompare(b.t))
      .slice(0, 10);
    return json({ n: t.n, best: top(t.best), worst: top(t.worst) });
  }
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > 4000) return err("Too large", 413);
    let body;
    try { body = JSON.parse(raw); } catch { return err("Bad JSON"); }
    if (typeof body.id !== "string" || !/^[a-z0-9]{6,64}$/i.test(body.id)) return err("Bad id");
    const best = cleanList(body.best), worst = cleanList(body.worst);
    if (!best.length && !worst.length) return err("Empty");
    await totals(s, K); // make sure older votes are counted before adding diffs
    const key = K.vote + body.id.toLowerCase();
    const prev = await s.get(key, { type: "json" });
    await s.setJSON(key, { best, worst, t: Date.now() });
    await update(s, K.totals, (t) => {
      if (prev) { bump(t.best, prev.best, -1); bump(t.worst, prev.worst, -1); } else t.n++;
      bump(t.best, best, 1); bump(t.worst, worst, 1);
      return t;
    }, emptyTotals);
    return json({ ok: true });
  }
  return err("Method not allowed", 405);
}

async function films(req, s, ctx, K) {
  const admin = isAdmin(req);
  if (req.method === "GET") {
    const wantAdmin = admin && new URL(req.url).searchParams.has("admin");
    if (K.all) {
      const out = { films: [], hidden: [] };
      for (const l of LANGS) {
        const f = (await s.get(keys(l).films, { type: "json" })) || emptyFilms();
        for (const x of f.films) out.films.push(wantAdmin ? { ...x, l } : { t: x.t, m: x.m, k: x.k, l });
        for (const h of f.hidden) out.hidden.push(wantAdmin ? { k: h, l } : h);
      }
      return json(wantAdmin ? out : { films: out.films });
    }
    const f = (await s.get(K.films, { type: "json" })) || emptyFilms();
    if (wantAdmin) return json(f);
    return json({ films: f.films.map(({ t, m, k }) => ({ t, m, k })) });
  }
  if (req.method !== "POST") return err("Method not allowed", 405);
  const raw = await req.text();
  if (raw.length > 2000) return err("Too large", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return err("Bad JSON"); }

  if (body.action) {
    if (!admin) return err("Wrong admin password", 401);
    if (K.all && body.action !== "check" && body.action !== "recount") return err("Pick a language to change films.");
    if (body.action === "check") return json({ ok: true });
    if (body.action === "recount") { const t = await recount(s, K); return json({ ok: true, n: t.n }); }
    const k = norm(body.k || "");
    if (!k) return err("Missing film");
    const out = await update(s, K.films, (f) => {
      if (body.action === "delete") {
        f.films = f.films.filter((x) => x.k !== k);
        if (!f.hidden.includes(k)) f.hidden.push(k);
      } else if (body.action === "restore") {
        f.hidden = f.hidden.filter((x) => x !== k);
      } else return undefined;
      return f;
    }, emptyFilms);
    return json({ ok: true, ...out });
  }

  if (K.all) return err("Pick a language for the film.");
  if (typeof body.id !== "string" || !/^[a-z0-9]{6,64}$/i.test(body.id)) return err("Bad id");
  const t = tidy(body.t || ""), k = norm(t), m = body.m;
  if (t.length < 2 || !k) return err("Type the film's name.");
  if (/https?:|www\.|\.(com|in|net|org|xyz|io|me)\b/i.test(t)) return err("Links aren't allowed in film names.");
  if (!MONTHS.includes(m)) return err("Pick the release month.");
  const dev = hash(body.id.toLowerCase()), ip = hash((ctx && ctx.ip) || "none"), day = today();

  let result;
  await update(s, K.films, (f) => {
    const ex = f.films.find((x) => x.k === k);
    if (ex) { result = { ok: true, film: { t: ex.t, m: ex.m, k: ex.k }, existed: true }; return undefined; }
    if (f.hidden.includes(k)) { result = { status: 403, error: "This film name was removed by the site owner." }; return undefined; }
    if (f.films.length >= MAX_FILMS) { result = { status: 429, error: "The film list is full." }; return undefined; }
    const todays = f.films.filter((x) => x.d === day);
    if (todays.filter((x) => x.by === dev).length >= PER_DEVICE_DAY ||
        todays.filter((x) => x.ip === ip).length >= PER_IP_DAY) {
      result = { status: 429, error: "You've added a lot of films today. Try again tomorrow." };
      return undefined;
    }
    f.films.push({ t, m, k, d: day, at: Date.now(), by: dev, ip });
    result = { ok: true, film: { t, m, k } };
    return f;
  }, emptyFilms);
  return result.error ? err(result.error, result.status) : json(result);
}

export default async (req, ctx) => {
  const s = store();
  try {
    const url = new URL(req.url);
    const lang = url.searchParams.get("lang") || "ta";
    if (lang !== "all" && !LANGS.includes(lang)) return err("Unknown language");
    const K = lang === "all" ? { vote: "all-v-", totals: "all-totals", films: null, all: true } : keys(lang);
    return url.pathname.startsWith("/api/films") ? await films(req, s, ctx, K) : await votes(req, s, K);
  } catch (e) {
    console.error(e);
    return err(e && e.message === "busy" ? "Busy, try again." : "Server error", 503);
  }
};
