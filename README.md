# Las Vegas winter trip 2026

Bilingual (English / 中文) trip site for Dec 23, 2026 – Jan 1, 2027: itinerary, flights, parks, a moon and stargazing planner with live cloud forecasts, a budget calculator, and an Ask Claude tab.

Live site: https://xmiao8.github.io/vegas-trip-2026/

## Pages

| File | What it is |
|---|---|
| `index.html` | Day-by-day itinerary and checklist |
| `flights.html` | Madison / Chicago flight options with round-trip prices |
| `parks.html` | Death Valley, Zion, Lake Mead, the Sphere, prime rib |
| `sky.html` | Moonrise times, dark-sky windows, live cloud forecast (Open-Meteo) |
| `budget.html` | Per-person budget calculator |
| `ask.html` | Chat with Claude about the trip |
| `site.css`, `site.js` | Shared styles, language switching and navigation |
| `trip-context.md` | Text of every page, which Claude reads before answering |

## Ask Claude

`ask.html` talks to a Cloudflare Worker (`worker/worker.js`) so the Anthropic API key never appears on this public site. The worker checks a shared group passcode, adds `trip-context.md` and a live cloud forecast, calls Claude, and streams the answer back.

Worker secrets (Cloudflare dashboard → worker → Settings → Variables and Secrets):

- `ANTHROPIC_API_KEY`: the Anthropic API key
- `PASSCODE`: the passcode the group types on the Ask Claude page

Set a monthly spend limit on the Anthropic account as a backstop.

After editing any page, rebuild Claude's copy of the plan:

```sh
node tools/build-context.js
```
