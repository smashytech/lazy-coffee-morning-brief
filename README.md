# Morning Brief

A personal, newspaper-style cybersecurity news digest powered by Claude AI. Fetches articles from RSS feeds, summarises them, groups them by topic, and surfaces the three most important stories of the day — all in one click.

![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646cff?logo=vite&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Sonnet-d97706)
![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

## Support

☕ If this project helped you, consider [buying me a coffee](https://buymeacoffee.com/devzelin).
<img width="1247" height="943" alt="image" src="https://github.com/user-attachments/assets/f82e63e1-44ad-48e1-8aba-3837814fb848" />


## Features

- **AI summaries** — Claude writes a 2–3 sentence plain-English summary for every article
- **Must-reads** — Claude picks the 3 most important stories a security professional should read today
- **Topic grouping** — articles are automatically categorised (Ransomware, Zero-Day, Nation-State, etc.)
- **Custom feeds** — add any RSS/Atom feed alongside the built-in sources
- **Read history** — previously seen articles are tracked in `localStorage` so you never see repeats
- **Digest library** — past daily digests are saved and browsable by date
- **Newspaper layout** — clean serif typography with optional 2-column view

Default sources: **The Hacker News**, **BleepingComputer**, **Risky Business**

## Quick start

### 1. Get an Anthropic API key (5€ will last you a long time)

Create a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

### 2. Configure environment

```bash
cp .env.example .env
# Open .env and set ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Install & run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and click **Fetch Today's Brief**.

## Docker

```bash
docker compose up
```

The app will be available at [http://localhost:5173](http://localhost:5173).

## How it works

1. **Fetch** — RSS feeds are fetched server-side through a Vite proxy (avoids CORS, keeps the API key off the client)
2. **Deduplicate** — items already in your read history are filtered out
3. **Summarise** — all fresh articles are sent to Claude in a single API call; Claude returns summaries, topic labels, and a top-3 ranking
4. **Render** — results are grouped by topic and displayed with a "Must-reads" section at the top
5. **Persist** — newly read article IDs are stored in `localStorage`; the full digest is saved to the library

Your API key lives only in `.env` and is never sent to the browser.

## Project structure

```
src/
  App.jsx       # entire app — feed management, fetching, AI processing, rendering
  main.jsx      # React entry point
index.html
vite.config.js  # dev server + proxy rules
Dockerfile
docker-compose.yml
.env.example
```

## Stack

| Layer | Technology |
|---|---|
| UI | React 18, Vite 5 |
| Fonts | Playfair Display, Lora (Google Fonts) |
| AI | Claude Sonnet via Anthropic Messages API |
| Storage | Browser `localStorage` |
| Proxy | Vite dev server proxy |
| Container | Docker / docker-compose |

## License

MIT
