// Ask Claude — Cloudflare Worker for the Las Vegas trip site.
//
// Keeps the Anthropic API key off the public website. The page sends a question; this
// worker adds the trip plan and a live cloud forecast, calls Claude, and streams the
// answer back. It adds up what every answer costs and stops for the week at $100.
//
// Settings (Cloudflare dashboard → this worker → Settings):
//   ANTHROPIC_API_KEY  secret: your Anthropic API key
//   USAGE              KV namespace binding: keeps the weekly spend and per-person counts
//   PASSCODE           optional secret: if set, the page must send this passcode

const SITE = "https://xmiao8.github.io/vegas-trip-2026/";
const ALLOWED_ORIGINS = ["https://xmiao8.github.io"];
const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 1200;
const MAX_TURNS = 20;          // messages kept per conversation
const MAX_CHARS = 2000;        // per message
const WEEKLY_CAP_USD = 100;    // stop answering once this week's spend reaches this (resets Monday, Las Vegas time)
const PER_PERSON_HOURLY = 30;  // questions per hour from one IP address

// Claude Opus 5.5 prices, USD per million tokens (platform.claude.com pricing, Nov 2026).
const PRICE = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };

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
- If asked what model you are, say you're Claude, made by Anthropic, without naming a specific model or version.
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
    if (request.method === "GET" && url.pathname === "/usage") {
      if (!env.USAGE) return json(500, { error: "not_configured" });
      const week = weekKey();
      return json(200, { week: week.slice(6), spentUSD: round(await getSpend(env, week)), capUSD: WEEKLY_CAP_USD });
    }
    if (request.method !== "POST" || url.pathname !== "/ask") return json(404, { error: "not_found" });
    if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { error: "origin" });
    // Without the usage store the weekly cap can't be enforced, so refuse rather than run uncapped.
    if (!env.ANTHROPIC_API_KEY || !env.USAGE) return json(500, { error: "not_configured" });

    let body;
    try { body = await request.json(); } catch { return json(400, { error: "bad_json" }); }
    if (env.PASSCODE && (typeof body.passcode !== "string" || !safeEqual(body.passcode.trim(), env.PASSCODE))) return json(401, { error: "passcode" });

    const week = weekKey();
    if (await getSpend(env, week) >= WEEKLY_CAP_USD) return json(429, { error: "weekly_cap" });
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const hourKey = `ip:${ip}:${new Date().toISOString().slice(0, 13)}`;
    const asked = Number(await env.USAGE.get(hourKey)) || 0;
    if (asked >= PER_PERSON_HOURLY) return json(429, { error: "rate_limited" });
    ctx.waitUntil(env.USAGE.put(hourKey, String(asked + 1), { expirationTtl: 3700 }));

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
    // Pass the answer straight through, reading the token counts on the way to record the cost.
    return new Response(upstream.body.pipeThrough(meter(env, week)), {
      headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  },
};

// Watches the streamed events for token usage; when the answer ends, adds its cost to the week.
function meter(env, week) {
  const dec = new TextDecoder();
  let buf = "";
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const read = evt => {
    for (const line of evt.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
      const u = d.type === "message_start" ? d.message && d.message.usage : d.type === "message_delta" ? d.usage : null;
      if (!u) continue;
      if (u.input_tokens != null) usage.input = u.input_tokens;
      if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
      if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
      if (u.output_tokens != null) usage.output = u.output_tokens;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { read(buf.slice(0, i)); buf = buf.slice(i + 2); }
    },
    async flush() {
      if (buf) read(buf);
      const cost = (usage.input * PRICE.input + usage.cacheWrite * PRICE.cacheWrite + usage.cacheRead * PRICE.cacheRead + usage.output * PRICE.output) / 1e6;
      if (cost > 0) await addSpend(env, week, cost);
    },
  });
}

// "spend:YYYY-MM-DD" for the Monday that starts this week, in Las Vegas time.
function weekKey() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return "spend:" + d.toISOString().slice(0, 10);
}
async function getSpend(env, week) { return Number(await env.USAGE.get(week)) || 0; }
async function addSpend(env, week, cost) {
  const now = await getSpend(env, week);
  await env.USAGE.put(week, String(now + cost), { expirationTtl: 60 * 60 * 24 * 21 });
}
const round = n => Math.round(n * 100) / 100;

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
