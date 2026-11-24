# n8n version (paused)

The original implementation of the autoposter as three n8n workflows. It works end to end, but is **paused**: it needs a machine that is always on, and my home PC can't be (see the main README). The production version is the Cloudflare Worker in `../worker/`.

| Workflow | What it does |
|---|---|
| `wf2-drafts.json` | Weekdays 09:00: if the queue has < 3 approved posts, reads Telegram channels, generates UA/RU/EN with Gemini (OpenRouter fallback), saves drafts, sends them to Telegram with buttons |
| `wf3-approval-buttons.json` | Every minute: polls Telegram `getUpdates`, applies ✅ / 🔄 / ❌ to the `Posts` data table, re-runs WF2 for "another topic" |
| `wf4-publisher.json` | Weekdays 10:00: random wait 0–224 min, publishes the next approved post to LinkedIn, notifies in Telegram |

Setup: [docs/setup.md](docs/setup.md). For a VPS: `deploy/` (Docker Compose + Caddy + DuckDNS).

> Don't run this and the Worker with the same Telegram bot at the same time: Telegram delivers button presses either to a webhook (Worker) or to `getUpdates` (n8n), not both.
