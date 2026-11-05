// Ask Claude — Cloudflare Worker for the Las Vegas trip site.
//
// Keeps the Anthropic API key off the public website. The page sends a question plus
// the shared passcode; this worker adds the trip plan and a live cloud forecast,
// calls Claude, and streams the answer back.
//
// Secrets (Cloudflare dashboard → this worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  your Anthropic API key
//   PASSCODE           the passcode your group types on the Ask Claude page

const SITE = "https://xmiao8.github.io/vegas-trip-2026/";
const ALLOWED_ORIGINS = ["https://xmiao8.github.io"];
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1200;
const MAX_TURNS = 20;          // messages kept per conversation
const MAX_CHARS = 2000;        // per message

const PLACES = {
  "Las Vegas Strip": [36.1147, -115.1728],
  "Lake Mead / Hoover Dam": [36.033, -114.8],
  "Death Valley (Furnace Creek)": [36.4618, -116.865],
  "Zion (Springdale)": [37.1889, -112.9986],
};

const INSTRUCTIONS = `You are the trip assistant on a website four friends from Madison, Wisconsin made for their winter trip to Las Vegas (Dec 23, 2026 – Jan 1, 2027). The full plan from the website is below, followed by a live cloud forecast.

How to answer:
- Base answers on the trip plan first. Use your general knowledge for anything the plan doesn't cover, and say when you're doing that.
- Prices, hours and closures in the plan were checked in early November 2026 and can change. Say so when it matters, and suggest where to check.
- You can't browse the web, book anything or see anyone's reservations.
- Be concise and practical: short paragraphs or a few bullet points. Use **bold** sparingly. No tables or headings.
- If asked to change the plan, suggest the change and explain the trade-offs; you can't edit the website.
- Reply in the language the person writes in. If they write in Chinese, reply in Simplified Chinese.
- Stay on the trip and things related to it (travel, Las Vegas, the parks, the sky, packing, money). Politely decline unrelated requests.`;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return json(200, { ok: true, service: "vegas-trip ask" });
    if (request.method !== "POST" || url.pathname !== "/ask") return json(404, { error: "not_found" });
    if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { error: "origin" });
    if (!env.ANTHROPIC_API_KEY || !env.PASSCODE) return json(500, { error: "not_configured" });

    let body;
    try { body = await request.json(); } catch { return json(400, { error: "bad_json" }); }
    if (typeof body.passcode !== "string" || !safeEqual(body.passcode.trim(), env.PASSCODE)) return json(401, { error: "passcode" });

    const msgs = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
    const clean = msgs
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map(m => ({ role: m.role, content: m.content.slice(0, m.role === "user" ? MAX_CHARS : 8000) }));
    while (clean.length && clean[0].role !== "user") clean.shift();
    if (!clean.length || clean[clean.length - 1].role !== "user") return json(400, { error: "no_question" });

    const [plan, forecast] = await Promise.all([getPlan(ctx), getForecast(ctx)]);
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: [
          // The plan changes rarely, so it is cached between questions (cheaper and faster).
          { type: "text", text: `${INSTRUCTIONS}\n\n<trip_plan>\n${plan}\n</trip_plan>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Today is ${today} (Las Vegas time).\n\n<live_cloud_forecast>\n${forecast}\n</live_cloud_forecast>` },
        ],
        messages: clean,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.log("anthropic error", upstream.status, detail.slice(0, 500));
      return json(upstream.status === 429 || upstream.status === 529 ? 503 : 502, { error: "upstream", status: upstream.status });
    }
    return new Response(upstream.body, {
      headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Trip plan from the website, cached for 10 minutes so edits show up quickly.
async function getPlan(ctx) {
  return cached(ctx, SITE + "trip-context.md", 600, async () => {
    const r = await fetch(SITE + "trip-context.md", { cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error("plan " + r.status);
    return r.text();
  }).catch(() => "(The trip plan couldn't be loaded right now. Answer from general knowledge and say the plan is unavailable.)");
}

// Evening cloud cover (6 p.m.–midnight local) for each place, cached for an hour.
async function getForecast(ctx) {
  const lat = Object.values(PLACES).map(p => p[0]).join(",");
  const lon = Object.values(PLACES).map(p => p[1]).join(",");
  const api = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,cloud_cover_high&timezone=America%2FLos_Angeles&forecast_days=16`;
  return cached(ctx, api, 3600, async () => {
    const r = await fetch(api);
    if (!r.ok) throw new Error("forecast " + r.status);
    const data = await r.json();
    const sets = Array.isArray(data) ? data : [data];
    const names = Object.keys(PLACES);
    const lines = [`Source: Open-Meteo, fetched ${new Date().toISOString().slice(0, 16)}Z. Average cloud cover from 6 p.m. to midnight local time (0% = clear). Forecasts reach 16 days ahead; trip nights further out aren't available yet.`];
    sets.forEach((set, i) => {
      const t = set.hourly.time, c = set.hourly.cloud_cover;
      const byDay = {};
      t.forEach((ts, j) => {
        const hour = Number(ts.slice(11, 13));
        if (hour >= 18) (byDay[ts.slice(0, 10)] ||= []).push(c[j]);
      });
      const days = Object.entries(byDay).map(([d, v]) => `${d}: ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}%`);
      lines.push(`${names[i]} — ${days.join(", ")}`);
    });
    return lines.join("\n");
  }).catch(() => "(Live forecast unavailable right now.)");
}

async function cached(ctx, key, ttl, make) {
  const cache = caches.default;
  const req = new Request("https://cache.internal/" + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) return hit.text();
  const text = await make();
  ctx.waitUntil(cache.put(req, new Response(text, { headers: { "Cache-Control": `max-age=${ttl}` } })));
  return text;
}
