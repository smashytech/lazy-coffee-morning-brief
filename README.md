# Morning Brief

A personal AI-powered news digest for The Hacker News, BleepingComputer, and Risky Business — plus any RSS/Atom feed you add yourself.

## Setup (one-time)

### 1. Install Node.js
If you don't have it: https://nodejs.org — download the "LTS" version and install it.

### 2. Add your Anthropic API key
- Copy `.env.example` to `.env`
- Go to https://console.anthropic.com/settings/keys and create a key
- Paste it into `.env` so it reads: `ANTHROPIC_API_KEY=sk-ant-...`

(If you'd rather run a local model via Ollama or Open-WebUI, you can skip the key and configure a local LLM in the Sources panel.)

### 3. Install dependencies
Open a terminal in this folder and run:
```
npm install
```

## Running the app

```
npm run dev
```

Then open http://localhost:5173 in your browser. Ctrl+C to stop.

### Running in Docker (optional)
```
docker compose up
```
The port is bound to `127.0.0.1:5173` so only your own machine can reach it — the Anthropic proxy would otherwise hand your API key to anyone on your LAN.

## How it works

- **Feeds** are fetched through a small dev-server proxy in [vite.config.js](vite.config.js) — the browser can't fetch RSS across origins directly, so the proxy does it server-side and streams the XML back.
- **AI summaries** come from Claude via the Anthropic API (proxied the same way, so your key stays on the server) or from a local LLM you point at.
- **Read history** is tracked in localStorage so articles you've already seen don't reappear. Capped at the last 500 IDs.
- **Library** stores the last 30 days of digests in localStorage so you can browse past briefs.
- Your API key lives only in `.env` and is never sent to the browser.
