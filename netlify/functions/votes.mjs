import { getStore } from "@netlify/blobs";

export const config = { path: "/api/votes" };

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (a) => {
  if (!Array.isArray(a)) return [];
  const seen = new Set();
  const out = [];
  for (const x of a.slice(0, 10)) {
    if (typeof x !== "string") continue;
    const t = x.trim().slice(0, 60);
    const k = norm(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
};
const add = (o, arr) => {
  for (const t of arr || []) {
    const k = norm(t);
    if (!k) continue;
    o[k] = o[k] || { t, c: 0 };
    o[k].c++;
  }
};

async function stats(store) {
  const cached = await store.get("stats", { type: "json" });
  if (cached && Date.now() - cached.t < 60000) return cached;
  const { blobs } = await store.list({ prefix: "v-" });
  const tb = {}, tw = {};
  let n = 0;
  for (const b of blobs.slice(0, 2000)) {
    const v = await store.get(b.key, { type: "json" });
    if (!v) continue;
    n++;
    add(tb, v.best);
    add(tw, v.worst);
  }
  const top = (o) =>
    Object.values(o).sort((a, b) => b.c - a.c || a.t.localeCompare(b.t)).slice(0, 10);
  const s = { t: Date.now(), n, best: top(tb), worst: top(tw) };
  await store.setJSON("stats", s);
  return s;
}

export default async (req) => {
  const store = getStore("votes");
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > 4000) return new Response("Too large", { status: 413 });
    let body;
    try { body = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }
    if (typeof body.id !== "string" || !/^[a-z0-9]{6,64}$/i.test(body.id))
      return new Response("Bad id", { status: 400 });
    const best = clean(body.best), worst = clean(body.worst);
    if (!best.length && !worst.length) return new Response("Empty", { status: 400 });
    await store.setJSON("v-" + body.id.toLowerCase(), { best, worst, t: Date.now() });
    return Response.json({ ok: true });
  }
  if (req.method === "GET") return Response.json(await stats(store));
  return new Response("Method not allowed", { status: 405 });
};
