# ☕ Lazy Coffee Morning Brief

A personal AI-powered cybersecurity news digest. Fetches RSS feeds, summarises each article in 2–3 sentences, groups them by topic, picks the top 3 must-reads, and presents everything as a clean editorial newsletter.

Built by **Rikard Zelin & Claude**.

---

## Features

-  Fetches from The Hacker News, BleepingComputer, and Risky Business (fully configurable)
-  AI summarisation via **Anthropic Claude** or a **local LLM** (Ollama / Open-WebUI)
-  Top 3 must-reads picked automatically each day
-  Topics grouped and collapsible
-  Library — every past digest saved and browsable
-  Read-history tracking — no duplicate articles across days
-  Light, Dark, and Geek (green terminal) themes
-  Single or two-column layout
-  Add/remove RSS sources from the UI

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- An [Anthropic API key](https://console.anthropic.com/settings/keys) *(only if using Claude — not needed for local LLM)*

---

## Setup (one-time)

**1. Add your API key**

Rename `.env.example` to `.env` and paste your Anthropic key:
```
ANTHROPIC_API_KEY=sk-ant-...
```
If you're using a local LLM only, leave this blank — it's optional.

**2. Build and start**

```bash
docker compose up -d --build
```

**3. Open the app**

Go to **http://localhost:5173** in your browser.

---

## Daily use

The container runs in the background automatically. Just open the browser and click **Fetch Today's Brief**.

To start/stop manually:
```bash
docker compose up -d    # start in background
docker compose down     # stop
```

---

## Using a local LLM (Ollama / Open-WebUI)

1. Open **⚙ Sources** in the app
2. Scroll to **AI Provider** and select **🖥 Local LLM**
3. Enter your server URL (e.g. `http://192.168.1.x:11434` for Ollama)
4. Enter the model name (e.g. `llama3`, `mistral`, `gemma3`)
5. Optionally enter an API key if your server requires one

The server must be reachable from the machine running Docker. For Ollama, make sure it's running with `ollama serve` and the model is pulled with `ollama pull <model>`.

> **Note:** Larger models (13B+) follow the JSON output format more reliably. Smaller models may occasionally return malformed responses.

---

## Adding RSS sources

Open **⚙ Sources**, enter a name and RSS/Atom feed URL, and click **Add**. The app validates the feed before saving. Examples:
- `https://krebsonsecurity.com/feed/`
- `https://www.schneier.com/feed/atom/`
- `https://feeds.feedburner.com/eset/blog`

---

## How it works

| Step | What happens |
|------|-------------|
| Fetch | RSS feeds are fetched server-side via a Vite proxy (no CORS issues, no third-party services) |
| Parse | Raw XML is parsed in the browser using `DOMParser` |
| Deduplicate | Article URLs are checked against a seen-cache in `localStorage` |
| Summarise | New articles are sent to Claude (or local LLM) in one batch call |
| Store | Summaries and top 3 are saved to the Library in `localStorage` |

Your Anthropic API key is injected server-side by the Vite proxy and is **never exposed to the browser**.

---

## Security note

Before pushing to a public repository, make sure `.env` is in your `.gitignore` and has never been committed. Verify with:
```bash
git log --all --full-history -- .env
```
If it appears, rotate your API key immediately at [console.anthropic.com](https://console.anthropic.com/settings/keys).
