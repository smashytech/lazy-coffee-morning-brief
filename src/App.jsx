import { useState } from "react";

// ─── Default feeds ─────────────────────────────────────────────────────────────
const DEFAULT_FEEDS = [
  { id: "thn", name: "The Hacker News",  url: "https://feeds.feedburner.com/TheHackersNews", tag: "THN", enabled: true, builtin: true },
  { id: "bc",  name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/",       tag: "BC",  enabled: true, builtin: true },
  { id: "rb",  name: "Risky Business",   url: "https://risky.biz/feeds/risky-business/",      tag: "RB",  enabled: true, builtin: true },
];

const FEEDS_KEY   = "digest:feeds_v1";
const SEEN_KEY    = "digest:seen_v2";
const LIBRARY_KEY = "digest:library_v1";  // stores past digests by date string

// ─── Storage helpers ───────────────────────────────────────────────────────────

function loadFeeds() {
  try { const r = localStorage.getItem(FEEDS_KEY); return r ? JSON.parse(r) : DEFAULT_FEEDS; }
  catch { return DEFAULT_FEEDS; }
}
function saveFeeds(f) { localStorage.setItem(FEEDS_KEY, JSON.stringify(f)); }

function loadSeen() {
  try { const r = localStorage.getItem(SEEN_KEY); return new Set(r ? JSON.parse(r) : []); }
  catch { return new Set(); }
}
function saveSeen(s) { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }

// Library: { "2025-03-06": { date, groups, top3, stats }, ... }
function loadLibrary() {
  try { const r = localStorage.getItem(LIBRARY_KEY); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
function saveLibrary(lib) { localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib)); }

function todayKey() {
  // Returns "YYYY-MM-DD" in local time — used as the library key
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function isRecent(dateStr) {
  // No date = include it (better than silently dropping)
  if (!dateStr) return true;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true; // unparseable = include
    // Accept anything in the last 48h to handle timezone differences
    // and feeds that publish just after midnight
    const hours48ago = new Date(Date.now() - 48 * 60 * 60 * 1000);
    return d >= hours48ago;
  } catch { return true; }
}

function clearSeenCache() {
  localStorage.removeItem("digest:seen_v2");
}

function makeTag(name) {
  return name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 4) || "???";
}

// ─── RSS fetching ──────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  const res = await fetch(`/proxy?url=${encodeURIComponent(feed.url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.name}`);
  const xml = await res.text();

  // Log the first 300 chars so we can see what we're actually getting back
  console.log(`[${feed.name}] raw XML preview:`, xml.slice(0, 300));

  // Try XML first, fall back to HTML parser (handles broken XML)
  let doc = new DOMParser().parseFromString(xml, "text/xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    console.warn(`[${feed.name}] XML parse error, trying text/html`);
    doc = new DOMParser().parseFromString(xml, "text/html");
  }

  // querySelectorAll doesn't handle namespace prefixes like <atom:entry>.
  // Use getElementsByTagName instead — it ignores namespaces.
  let items = [...doc.getElementsByTagName("item")];
  if (items.length === 0) items = [...doc.getElementsByTagName("entry")];
  console.log(`[${feed.name}] found ${items.length} items via getElementsByTagName`);

  items = items.slice(0, 12);

  return items.map(item => {
    // Also use getElementsByTagName for child elements to handle namespaced tags
    const getText = tag => {
      const el = item.getElementsByTagName(tag)[0];
      return el?.textContent?.trim() || "";
    };

    // <link> can be text content (RSS) or href attribute (Atom)
    const linkEl = item.getElementsByTagName("link")[0];
    const link =
      linkEl?.getAttribute("href") ||
      linkEl?.textContent?.trim() ||
      getText("guid");

    const description =
      getText("description") ||
      getText("summary") ||
      getText("content") ||
      getText("content:encoded");

    return {
      id:          link,
      title:       getText("title"),
      link,
      source:      feed.name,
      sourceTag:   feed.tag,
      description: description.replace(/<[^>]*>/g, "").slice(0, 600),
      pubDate:     getText("pubDate") || getText("published") || getText("updated"),
    };
  }).filter(it => it.id && it.title && isRecent(it.pubDate));
}

// ─── AI: summarise + categorise + pick top 3 ──────────────────────────────────
// We do everything in one API call to keep costs low.
// Claude returns { summaries: [{index,summary,topic}], top3: [index,index,index] }

async function aiProcess(items) {
  const payload = items.map((it, i) =>
    `[${i}] SOURCE: ${it.source}\nTITLE: ${it.title}\nBODY: ${it.description}`
  ).join("\n\n---\n\n");

  const res = await fetch("/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: `You are a cybersecurity news editor. Given a list of articles:

1. For each article write a 2–3 sentence plain-English summary and assign a short topic label (1–3 words, e.g. Ransomware, Vulnerabilities, Data Breach, Nation-State, Malware, Privacy, Podcast, Policy, Phishing, Cybercrime, AI Security, Zero-Day, Supply Chain).

2. Pick the 3 most important/newsworthy articles a security professional should read today. Use their index numbers.

3.  Do NOT start any sentence with "The article discusses", "This article", or similar phrases.

4.  Write in active voice, leading with the subject of the news.

Respond ONLY with a valid JSON object — no markdown fences, no extra text:
{
  "summaries": [{"index":0,"summary":"...","topic":"..."},...],
  "top3": [index1, index2, index3]
}`,
      messages: [{ role: "user", content: payload }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }

  const data = await res.json();
  const text = data.content.map(c => c.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(str) {
  try { return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function fmtLibraryDate(key) {
  // key is "YYYY-MM-DD" — parse as local date
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DigestApp() {
  const [phase,       setPhase]       = useState(() => loadLibrary()[todayKey()] ? "done" : "idle");
  const [newGroups,   setNewGroups]   = useState(() => loadLibrary()[todayKey()]?.groups || []);
  const [top3,        setTop3]        = useState(() => loadLibrary()[todayKey()]?.top3   || []);
  const [stats,       setStats]       = useState(() => loadLibrary()[todayKey()]?.stats  || null);
  const [errMsg,      setErrMsg]      = useState("");
  const [columns,     setColumns]     = useState(() => Number(localStorage.getItem("digest:columns")) || 1);
  const [theme,       setTheme]       = useState(() => {
    const t = localStorage.getItem("digest:theme");
    if (t) return t;
    return localStorage.getItem("digest:dark") === "1" ? "dark" : "light";
  });

  // Sources panel
  const [showSources, setShowSources] = useState(false);
  const [feeds,       setFeeds]       = useState(loadFeeds);
  const [newName,     setNewName]     = useState("");
  const [newUrl,      setNewUrl]      = useState("");
  const [addError,    setAddError]    = useState("");
  const [clearMsg,    setClearMsg]    = useState("");
  const [debugLog,    setDebugLog]    = useState([]);  // diagnostic messages shown during fetch
  const [collapsedTopics, setCollapsedTopics] = useState(new Set());

  // Library panel
  const [showLibrary,  setShowLibrary]  = useState(false);
  const [library,      setLibrary]      = useState(loadLibrary);
  const [libraryDay,   setLibraryDay]   = useState(null);  // key of day being viewed

  // ── Feed management ──────────────────────────────────────────────────────────

  function updateFeeds(next) { setFeeds(next); saveFeeds(next); }
  function toggleFeed(id)    { updateFeeds(feeds.map(f => f.id === id ? { ...f, enabled: !f.enabled } : f)); }
  function removeFeed(id)    { updateFeeds(feeds.filter(f => f.id !== id)); }

  async function addFeed() {
    setAddError("");
    const name = newName.trim(), url = newUrl.trim();
    if (!name || !url) { setAddError("Both name and URL are required."); return; }
    if (feeds.find(f => f.url === url)) { setAddError("This feed is already in your list."); return; }
    try {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`Got HTTP ${res.status}`);
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      if (doc.querySelector("parsererror")) throw new Error("Doesn't look like a valid RSS/Atom feed");
    } catch (e) { setAddError(`Couldn't load that feed: ${e.message}`); return; }

    const id = `custom_${Date.now()}`;
    updateFeeds([...feeds, { id, name, url, tag: makeTag(name), enabled: true, builtin: false }]);
    setNewName(""); setNewUrl("");
  }

  // ── Main fetch ───────────────────────────────────────────────────────────────

  async function run() {
    const activeFeeds = feeds.filter(f => f.enabled);
    if (activeFeeds.length === 0) {
      setErrMsg("No sources enabled. Open Sources to add or enable some.");
      setPhase("error"); return;
    }

    setPhase("fetching"); setErrMsg(""); setNewGroups([]); setTop3([]);
    setStats(null);

    try {
      const seen = loadSeen();

      // 1. Fetch all enabled feeds
      const fetchLog = [`Seen cache: ${seen.size} IDs`];
      let allItems = [];
      for (const feed of activeFeeds) {
        try {
          const items = await fetchFeed(feed);
          allItems = [...allItems, ...items];
          fetchLog.push(`✓ ${feed.name}: ${items.length} items`);
          console.log(`[fetch] ${feed.name}: ${items.length} items`);
        }
        catch (e) {
          fetchLog.push(`✗ ${feed.name}: ${e.message}`);
          console.warn(`[fetch] ${feed.name} failed:`, e.message);
        }
      }

      // 2. Deduplicate
      const deduped = allItems.reduce((acc, it) => acc.find(x => x.id === it.id) ? acc : [...acc, it], []);

      // Split into fresh (not yet seen)
      const freshItems = deduped.filter(it => !seen.has(it.id)).slice(0, 24);

      fetchLog.push(`Total: ${deduped.length} | Fresh: ${freshItems.length}`);
      console.log('[fetch] Summary:', fetchLog.join(' | '));
      setDebugLog(fetchLog);

      // 5. AI-process fresh articles
      let processed = [], pickedTop3 = [];
      if (freshItems.length > 0) {
        setPhase("processing");
        const aiResult = await aiProcess(freshItems);

        processed = (aiResult.summaries || [])
          .filter(r => r.index < freshItems.length)
          .map(r => ({ ...freshItems[r.index], summary: r.summary, topic: r.topic || "General" }));

        // top3 is an array of indices into freshItems — map to processed articles
        pickedTop3 = (aiResult.top3 || [])
          .map(idx => processed.find(p => p.id === freshItems[idx]?.id))
          .filter(Boolean)
          .slice(0, 3);
      }

      // 6. Group by topic
      const map = {};
      processed.forEach(it => { (map[it.topic] = map[it.topic] || []).push(it); });
      const grouped = Object.entries(map)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([topic, items]) => ({ topic, items }));

      // 7. Mark as seen
      processed.forEach(it => seen.add(it.id));
      saveSeen(seen);

      // 8. Save to library (overwrite today's entry if re-fetching)
      if (processed.length > 0) {
        const lib = loadLibrary();
        lib[todayKey()] = { date: TODAY, groups: grouped, top3: pickedTop3, stats: { newCount: processed.length, topicCount: grouped.length } };
        saveLibrary(lib);
        setLibrary(lib);
      }

      setNewGroups(grouped);
      setTop3(pickedTop3);
      setStats({ newCount: processed.length, topicCount: grouped.length });
      setPhase("done");
    } catch (e) {
      console.error(e);
      setErrMsg(e.message || "Unknown error");
      setPhase("error");
    }
  }

  // ── Library helpers ──────────────────────────────────────────────────────────

  const libraryDays   = Object.keys(library).sort().reverse();  // newest first
  const libraryEntry  = libraryDay ? library[libraryDay] : null;

  function toggleTopic(topic) {
    setCollapsedTopics(prev => {
      const next = new Set(prev);
      next.has(topic) ? next.delete(topic) : next.add(topic);
      return next;
    });
  }

  function openLibraryDay(key) { setLibraryDay(key); setShowSources(false); }
  function closeLibrary()      { setLibraryDay(null); setShowLibrary(false); }

  const isLoading    = phase === "fetching" || phase === "processing";
  const enabledCount = feeds.filter(f => f.enabled).length;
  const sourcesLabel = feeds.filter(f => f.enabled).map(f => f.name).join(" · ") || "No sources enabled";

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lora:ital,wght@0,400;0,500;1,400&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #f5f1e8; }
        .digest-wrap { font-family: 'Lora', Georgia, serif; background: #f5f1e8; color: #1c1912; min-height: 100vh; padding: 0 1rem 4rem; }

        /* ── Masthead ── */
        .masthead { max-width: 720px; margin: 0 auto; padding: 1rem 0 0; text-align: center; }
        .masthead-top { display: flex; align-items: center; justify-content: center; gap: 1rem; margin-bottom: 0.9rem; }
        .masthead-meta  { font-size: 0.68rem; letter-spacing: 0.18em; text-transform: uppercase; color: #7a6f5a; }
        .masthead-title { font-family: 'Playfair Display', Georgia, serif; font-size: clamp(2.8rem, 8vw, 5rem); font-weight: 700; line-height: 1; color: #1c1912; }
        .masthead-rule-top  { border: none; border-top: 3px solid #1c1912; margin: 1.2rem 0 0; }
        .masthead-rule-thin { border: none; border-top: 1px solid #1c1912; margin: 0.3rem 0 1.4rem; }
        .masthead-sub { font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: #7a6f5a; padding-bottom: 0.5rem; }
        .masthead-byline { font-family: 'Lora', Georgia, serif; font-size: 0.72rem; font-style: italic; color: #9a8f7a; padding-bottom: 1.6rem; }

        /* Masthead action buttons */
        .masthead-actions { display: flex; gap: 0.5rem; align-items: center; }
        .hdr-btn {
          background: none; border: 1px solid #c8bda8; color: #7a6f5a;
          font-family: 'Lora', serif; font-size: 0.58rem; letter-spacing: 0.15em;
          text-transform: uppercase; padding: 0.45em 0.9em; cursor: pointer;
          border-radius: 2px; transition: all 0.15s; display: flex; align-items: center; gap: 0.4rem;
        }
        .hdr-btn:hover { background: #1c1912; color: #f5f1e8; border-color: #1c1912; }
        .hdr-btn.active { background: #1c1912; color: #f5f1e8; border-color: #1c1912; }
        .hdr-badge { background: #1c1912; color: #f5f1e8; font-size: 0.5rem; padding: 0.1em 0.45em; border-radius: 8px; }
        .hdr-btn.active .hdr-badge { background: #f5f1e8; color: #1c1912; }

        /* ── Panel base ── */
        .panel { max-width: 720px; margin: 0 auto 2rem; border: 1px solid #c8bda8; background: #faf7f0; padding: 1.6rem; }
        .panel-title { font-size: 0.62rem; letter-spacing: 0.22em; text-transform: uppercase; color: #7a6f5a; margin-bottom: 1.2rem; }

        /* ── Sources panel ── */
        .feed-row { display: flex; align-items: center; gap: 0.8rem; padding: 0.65rem 0; border-bottom: 1px solid #ece6da; }
        .feed-row:last-of-type { border-bottom: none; }
        .feed-toggle { position: relative; width: 32px; height: 18px; flex-shrink: 0; cursor: pointer; }
        .feed-toggle input { opacity: 0; width: 0; height: 0; }
        .feed-toggle-track { position: absolute; inset: 0; border-radius: 9px; background: #c8bda8; transition: background 0.2s; }
        .feed-toggle input:checked ~ .feed-toggle-track { background: #1c1912; }
        .feed-toggle-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #f5f1e8; transition: transform 0.2s; }
        .feed-toggle input:checked ~ .feed-toggle-track .feed-toggle-thumb { transform: translateX(14px); }
        .feed-info { flex: 1; min-width: 0; }
        .feed-name { font-size: 0.85rem; color: #1c1912; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .feed-url  { font-size: 0.65rem; color: #9a8f7a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .feed-tag  { font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; background: #e8e1d4; color: #5a4e38; padding: 0.2em 0.55em; border-radius: 2px; flex-shrink: 0; }
        .feed-remove { background: none; border: none; color: #c8bda8; font-size: 1rem; cursor: pointer; line-height: 1; padding: 0 0.2rem; transition: color 0.15s; flex-shrink: 0; }
        .feed-remove:hover { color: #7a1e1e; }
        .add-feed-form { margin-top: 1.2rem; display: flex; flex-direction: column; gap: 0.6rem; }
        .add-feed-row  { display: flex; gap: 0.6rem; }
        .add-feed-input { flex: 1; background: #f5f1e8; border: 1px solid #c8bda8; color: #1c1912; font-family: 'Lora', serif; font-size: 0.78rem; padding: 0.55em 0.8em; border-radius: 2px; outline: none; }
        .add-feed-input:focus { border-color: #7a6f5a; }
        .add-feed-input::placeholder { color: #b0a48f; }
        .add-feed-btn { background: #1c1912; border: none; color: #f5f1e8; font-family: 'Lora', serif; font-size: 0.62rem; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.6em 1.2em; cursor: pointer; border-radius: 2px; white-space: nowrap; transition: opacity 0.15s; }
        .add-feed-btn:hover { opacity: 0.75; }
        .add-feed-error { font-size: 0.72rem; color: #7a1e1e; }

        /* ── Clear data ── */
        .clear-data-section { margin-top: 1.6rem; padding-top: 1.2rem; border-top: 1px dashed #c8bda8; }
        .clear-data-label { font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; color: #9a8f7a; margin-bottom: 0.7rem; }
        .clear-data-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
        .clear-btn { background: none; border: 1px solid #c8bda8; color: #7a6f5a; font-family: 'Lora', serif; font-size: 0.6rem; letter-spacing: 0.13em; text-transform: uppercase; padding: 0.45em 1em; cursor: pointer; border-radius: 2px; transition: all 0.15s; }
        .clear-btn:hover { border-color: #7a1e1e; color: #7a1e1e; }
        .clear-btn.danger:hover { background: #7a1e1e; color: #f5f1e8; border-color: #7a1e1e; }

        /* ── Library panel ── */
        .library-days { display: flex; flex-direction: column; gap: 0.2rem; }
        .library-day-btn { background: none; border: none; border-bottom: 1px solid #ece6da; padding: 0.7rem 0; cursor: pointer; text-align: left; font-family: 'Lora', serif; font-size: 0.82rem; color: #4a4132; display: flex; justify-content: space-between; align-items: center; transition: color 0.15s; }
        .library-day-btn:hover { color: #1c1912; }
        .library-day-btn.selected { color: #1c1912; font-weight: 600; }
        .library-day-stats { font-size: 0.62rem; color: #9a8f7a; letter-spacing: 0.08em; }
        .library-empty { font-size: 0.8rem; color: #9a8f7a; font-style: italic; }

        /* Library day view — reuses article/group styles */
        .library-back { background: none; border: none; font-family: 'Lora', serif; font-size: 0.62rem; letter-spacing: 0.15em; text-transform: uppercase; color: #7a6f5a; cursor: pointer; padding: 0; margin-bottom: 1.4rem; display: flex; align-items: center; gap: 0.4rem; transition: color 0.15s; }
        .library-back:hover { color: #1c1912; }
        .library-day-heading { font-family: 'Playfair Display', serif; font-size: 1.1rem; font-weight: 600; color: #1c1912; margin-bottom: 0.3rem; }
        .library-day-sub { font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: #9a8f7a; margin-bottom: 1.6rem; }

        /* ── Column layout toggle ── */
        .col-toggle { display: flex; border: 1px solid #c8bda8; border-radius: 2px; overflow: hidden; }
        .col-btn { background: none; border: none; color: #9a8f7a; cursor: pointer; padding: 0.38em 0.6em; font-size: 0.7rem; line-height: 1; transition: all 0.15s; }
        .col-btn:hover { background: #e8e1d4; color: #1c1912; }
        .col-btn.active { background: #1c1912; color: #f5f1e8; }

        /* 2-column: topic sections go full-width, articles inside go 2-col grid */
        .two-col .topic-section { max-width: 1100px; }
        .two-col .stats-bar     { max-width: 1100px; }
        .two-col .top3-section  { max-width: 1100px; }
        .two-col .digest-footer { max-width: 1100px; }
        .two-col .panel         { max-width: 1100px; }
        .two-col .top3-cards    { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 2rem; }
        .two-col .article-grid  { display: grid; grid-template-columns: 1fr 1fr; gap: 0 2.5rem; }
        .two-col .article       { break-inside: avoid; }
        @media (max-width: 800px) {
          .two-col .article-grid { grid-template-columns: 1fr; }
          .two-col .top3-cards   { grid-template-columns: 1fr; }
        }

        /* ── Top 3 section ── */
        .top3-section { max-width: 720px; margin: 0 auto 2.8rem; }
        .top3-header { font-size: 0.62rem; letter-spacing: 0.25em; text-transform: uppercase; color: #7a6f5a; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #1c1912; display: flex; align-items: center; gap: 0.6rem; }
        .top3-star { color: #1c1912; font-size: 0.7rem; }
        .top3-card { padding: 1.1rem 0 1.1rem 1.1rem; border-bottom: 1px solid #ddd5c4; border-left: 2px solid #1c1912; margin-bottom: 0.1rem; }
        .top3-card:last-child { border-bottom: none; }
        .top3-rank { font-size: 0.58rem; letter-spacing: 0.18em; text-transform: uppercase; color: #9a8f7a; margin-bottom: 0.35rem; }

        /* ── Idle ── */
        .idle-wrap { max-width: 720px; margin: 4rem auto; text-align: center; }
        .idle-greeting { font-family: 'Playfair Display', serif; font-size: 1.4rem; font-style: italic; color: #4a3f2a; margin-bottom: 0.6rem; }
        .idle-sub { font-size: 0.8rem; color: #9a8f7a; margin-bottom: 2rem; line-height: 1.7; }

        /* ── Buttons ── */
        .fetch-btn { background: #1c1912; border: none; color: #f5f1e8; font-family: 'Lora', serif; font-size: 0.72rem; letter-spacing: 0.18em; text-transform: uppercase; padding: 0.9em 2.4em; cursor: pointer; border-radius: 2px; transition: opacity 0.15s; }
        .fetch-btn:hover { opacity: 0.75; }
        .refresh-btn { background: none; border: 1px solid #9a8f7a; color: #5a4e38; font-family: 'Lora', serif; font-size: 0.6rem; letter-spacing: 0.14em; text-transform: uppercase; padding: 0.4em 1em; cursor: pointer; border-radius: 2px; transition: all 0.15s; }
        .refresh-btn:hover { background: #1c1912; color: #f5f1e8; border-color: #1c1912; }

        /* ── Loading ── */
        .status-wrap { max-width: 720px; margin: 4rem auto; text-align: center; }
        .spinner { width: 26px; height: 26px; border: 2px solid #c8bda8; border-top-color: #1c1912; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.2rem; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .status-label { font-size: 0.72rem; letter-spacing: 0.15em; text-transform: uppercase; color: #7a6f5a; }

        /* ── Error / caught-up ── */
        .err-head { font-family: 'Playfair Display', serif; font-size: 1.2rem; color: #7a1e1e; margin-bottom: 0.5rem; }
        .err-detail { font-size: 0.78rem; color: #7a6f5a; margin-bottom: 1.4rem; }
        .caught-up { font-family: 'Playfair Display', serif; font-size: 1.5rem; font-style: italic; color: #4a3f2a; margin-bottom: 0.5rem; }
        .caught-up-sub { font-size: 0.8rem; color: #7a6f5a; margin-bottom: 2rem; }

        /* ── Stats bar ── */
        .stats-bar { max-width: 720px; margin: 0 auto 2.5rem; display: flex; align-items: center; justify-content: space-between; font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; color: #7a6f5a; }

        /* ── Topic sections ── */
        .topic-section { max-width: 720px; margin: 0 auto 2.8rem; }
        .topic-header { font-size: 0.62rem; letter-spacing: 0.25em; text-transform: uppercase; color: #7a6f5a; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #c8bda8; display: flex; align-items: center; gap: 0.6rem; cursor: pointer; user-select: none; }
        .topic-header:hover { color: #1c1912; }
        .topic-count { background: #1c1912; color: #f5f1e8; font-size: 0.52rem; padding: 0.15em 0.55em; border-radius: 10px; }
        .topic-chevron { margin-left: auto; font-size: 0.7rem; transition: transform 0.2s; display: inline-block; }
        .topic-chevron.collapsed { transform: rotate(-90deg); }

        /* ── Articles ── */
        .article { padding: 1.1rem 0; border-bottom: 1px solid #ddd5c4; }
        .article:last-child { border-bottom: none; }
        .article-meta { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.45rem; }
        .source-tag { font-size: 0.56rem; letter-spacing: 0.14em; text-transform: uppercase; background: #e8e1d4; color: #5a4e38; padding: 0.2em 0.6em; border-radius: 2px; font-weight: 500; }
        .article-date { font-size: 0.64rem; color: #9a8f7a; }
        .article-title { font-family: 'Playfair Display', serif; font-size: 1.1rem; font-weight: 600; line-height: 1.35; color: #1c1912; text-decoration: none; display: block; margin-bottom: 0.5rem; transition: color 0.15s; }
        .article-title:hover { color: #5a3e1a; }
        .article-summary { font-size: 0.88rem; line-height: 1.7; color: #4a4132; }

        /* ── Footer ── */
        .digest-footer { max-width: 720px; margin: 3rem auto 0; padding-top: 1.4rem; border-top: 3px double #c8bda8; display: flex; align-items: center; justify-content: space-between; font-size: 0.64rem; letter-spacing: 0.1em; text-transform: uppercase; color: #9a8f7a; }

        /* ── Dark mode ── */
        .dark { background: #131110; color: #ede8df; }
        .dark .masthead-meta  { color: #5a5448; }
        .dark .masthead-title { color: #ede8df; }
        .dark .masthead-rule-top  { border-top-color: #ede8df; }
        .dark .masthead-rule-thin { border-top-color: #ede8df; }
        .dark .masthead-sub    { color: #5a5448; }
        .dark .masthead-byline { color: #3e3830; }
        .dark .hdr-btn { border-color: #3a342a; color: #6a6050; }
        .dark .hdr-btn:hover  { background: #ede8df; color: #131110; border-color: #ede8df; }
        .dark .hdr-btn.active { background: #ede8df; color: #131110; border-color: #ede8df; }
        .dark .hdr-badge { background: #ede8df; color: #131110; }
        .dark .hdr-btn.active .hdr-badge { background: #131110; color: #ede8df; }
        .dark .col-toggle { border-color: #3a342a; }
        .dark .col-btn { color: #6a6050; }
        .dark .col-btn:hover  { background: #2a2520; color: #ede8df; }
        .dark .col-btn.active { background: #ede8df; color: #131110; }
        .dark .panel { border-color: #2e2820; background: #1b1814; }
        .dark .panel-title { color: #5a5448; }
        .dark .feed-row { border-bottom-color: #2a2520; }
        .dark .feed-toggle-track { background: #3a342a; }
        .dark .feed-toggle input:checked ~ .feed-toggle-track { background: #ede8df; }
        .dark .feed-toggle-thumb { background: #131110; }
        .dark .feed-name { color: #ede8df; }
        .dark .feed-url  { color: #5a5448; }
        .dark .feed-tag  { background: #2a2520; color: #9a8e7a; }
        .dark .feed-remove { color: #3a342a; }
        .dark .feed-remove:hover { color: #d44444; }
        .dark .add-feed-input { background: #131110; border-color: #3a342a; color: #ede8df; }
        .dark .add-feed-input:focus { border-color: #6a6050; }
        .dark .add-feed-input::placeholder { color: #3e3830; }
        .dark .add-feed-btn { background: #ede8df; color: #131110; }
        .dark .add-feed-error { color: #d44444; }
        .dark .clear-data-section { border-top-color: #2e2820; }
        .dark .clear-data-label { color: #5a5448; }
        .dark .clear-btn { border-color: #3a342a; color: #6a6050; }
        .dark .clear-btn:hover { border-color: #d44444; color: #d44444; }
        .dark .clear-btn.danger:hover { background: #d44444; color: #ede8df; border-color: #d44444; }
        .dark .library-days { }
        .dark .library-day-btn { border-bottom-color: #2a2520; color: #9a8e7a; }
        .dark .library-day-btn:hover   { color: #ede8df; }
        .dark .library-day-btn.selected { color: #ede8df; }
        .dark .library-day-stats { color: #3e3830; }
        .dark .library-empty { color: #3e3830; }
        .dark .library-back { color: #5a5448; }
        .dark .library-back:hover { color: #ede8df; }
        .dark .library-day-heading { color: #ede8df; }
        .dark .library-day-sub { color: #5a5448; }
        .dark .stats-bar { color: #5a5448; }
        .dark .topic-header { color: #5a5448; border-bottom-color: #2e2820; }
        .dark .topic-header:hover { color: #ede8df; }
        .dark .topic-count { background: #ede8df; color: #131110; }
        .dark .article { border-bottom-color: #2a2520; }
        .dark .source-tag { background: #2a2520; color: #9a8e7a; }
        .dark .article-date { color: #3e3830; }
        .dark .article-title { color: #ede8df; }
        .dark .article-title:hover { color: #c8a870; }
        .dark .article-summary { color: #8a7e6e; }
        .dark .top3-header { color: #5a5448; border-bottom-color: #ede8df; }
        .dark .top3-star  { color: #ede8df; }
        .dark .top3-card  { border-bottom-color: #2a2520; border-left-color: #ede8df; }
        .dark .top3-rank  { color: #3e3830; }
        .dark .idle-greeting { color: #b0a48e; }
        .dark .idle-sub { color: #5a5448; }
        .dark .fetch-btn { background: #ede8df; color: #131110; }
        .dark .refresh-btn { border-color: #5a5448; color: #8a7e6e; }
        .dark .refresh-btn:hover { background: #ede8df; color: #131110; border-color: #ede8df; }
        .dark .status-label { color: #5a5448; }
        .dark .spinner { border-color: #2e2820; border-top-color: #ede8df; }
        .dark .err-head { color: #d44444; }
        .dark .err-detail { color: #5a5448; }
        .dark .caught-up { color: #b0a48e; }
        .dark .caught-up-sub { color: #5a5448; }
        .dark .digest-footer { border-top-color: #2e2820; color: #3e3830; }

        /* ── Geek / Terminal mode ── */
        .geek { background: #000; color: #33ff33; }
        .geek * { font-family: 'Courier New', Courier, monospace !important; font-style: normal !important; }
        .geek::before { content: ''; position: fixed; inset: 0; background: repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.12) 3px, rgba(0,0,0,0.12) 4px); pointer-events: none; z-index: 9999; }
        .geek .masthead-title { color: #33ff33; text-shadow: 0 0 18px #33ff33, 0 0 40px rgba(51,255,51,0.4); letter-spacing: 0.05em; }
        .geek .masthead-meta  { color: #00b800; }
        .geek .masthead-rule-top  { border-top-color: #33ff33; box-shadow: 0 0 8px #33ff33; }
        .geek .masthead-rule-thin { border-top-color: #007700; }
        .geek .masthead-sub    { color: #00b800; }
        .geek .masthead-byline { color: #007700; }
        .geek .hdr-btn { border-color: #33ff33; color: #33ff33; }
        .geek .hdr-btn:hover  { background: #33ff33; color: #000; border-color: #33ff33; }
        .geek .hdr-btn.active { background: #33ff33; color: #000; border-color: #33ff33; }
        .geek .hdr-badge { background: #33ff33; color: #000; }
        .geek .hdr-btn.active .hdr-badge { background: #000; color: #33ff33; }
        .geek .col-toggle { border-color: #33ff33; }
        .geek .col-btn { color: #33ff33; }
        .geek .col-btn:hover  { background: #002200; color: #33ff33; }
        .geek .col-btn.active { background: #33ff33; color: #000; }
        .geek .panel { border-color: #33ff33; background: #000; box-shadow: 0 0 16px rgba(51,255,51,0.12); }
        .geek .panel-title { color: #00b800; }
        .geek .feed-row { border-bottom-color: #002200; }
        .geek .feed-toggle-track { background: #002200; }
        .geek .feed-toggle input:checked ~ .feed-toggle-track { background: #33ff33; }
        .geek .feed-toggle-thumb { background: #000; }
        .geek .feed-name { color: #33ff33; }
        .geek .feed-url  { color: #00b800; }
        .geek .feed-tag  { background: #002200; color: #33ff33; }
        .geek .feed-remove { color: #002200; }
        .geek .feed-remove:hover { color: #ff3333; }
        .geek .add-feed-input { background: #000; border-color: #33ff33; color: #33ff33; }
        .geek .add-feed-input:focus { border-color: #33ff33; box-shadow: 0 0 6px #33ff33; }
        .geek .add-feed-input::placeholder { color: #003300; }
        .geek .add-feed-btn { background: #33ff33; color: #000; border: none; }
        .geek .add-feed-error { color: #ff3333; }
        .geek .clear-data-section { border-top-color: #002200; }
        .geek .clear-data-label { color: #007700; }
        .geek .clear-btn { border-color: #33ff33; color: #33ff33; }
        .geek .clear-btn:hover { border-color: #ff3333; color: #ff3333; }
        .geek .clear-btn.danger:hover { background: #ff3333; color: #000; border-color: #ff3333; }
        .geek .library-day-btn { border-bottom-color: #002200; color: #00b800; }
        .geek .library-day-btn:hover   { color: #33ff33; }
        .geek .library-day-btn.selected { color: #33ff33; }
        .geek .library-day-stats { color: #007700; }
        .geek .library-empty { color: #007700; }
        .geek .library-back { color: #00b800; }
        .geek .library-back:hover { color: #33ff33; }
        .geek .library-day-heading { color: #33ff33; text-shadow: 0 0 8px #33ff33; }
        .geek .library-day-sub { color: #00b800; }
        .geek .stats-bar { color: #007700; }
        .geek .topic-header { color: #00b800; border-bottom-color: #002200; }
        .geek .topic-header:hover { color: #33ff33; }
        .geek .topic-count { background: #33ff33; color: #000; }
        .geek .article { border-bottom-color: #002200; }
        .geek .source-tag { background: #002200; color: #33ff33; }
        .geek .article-date { color: #007700; }
        .geek .article-title { color: #33ff33; text-shadow: 0 0 5px rgba(51,255,51,0.5); }
        .geek .article-title:hover { color: #fff; text-shadow: 0 0 10px #fff; }
        .geek .article-summary { color: #00b800; }
        .geek .top3-header { color: #00b800; border-bottom-color: #33ff33; }
        .geek .top3-star  { color: #33ff33; text-shadow: 0 0 10px #33ff33; }
        .geek .top3-card  { border-bottom-color: #002200; border-left-color: #33ff33; box-shadow: -4px 0 12px rgba(51,255,51,0.2); }
        .geek .top3-rank  { color: #007700; }
        .geek .idle-greeting { color: #33ff33; text-shadow: 0 0 12px #33ff33; }
        .geek .idle-sub { color: #00b800; }
        .geek .fetch-btn { background: #33ff33; color: #000; }
        .geek .fetch-btn:hover { background: #000; color: #33ff33; border: 1px solid #33ff33; opacity: 1; }
        .geek .refresh-btn { border-color: #33ff33; color: #33ff33; }
        .geek .refresh-btn:hover { background: #33ff33; color: #000; border-color: #33ff33; }
        .geek .status-label { color: #33ff33; text-shadow: 0 0 6px #33ff33; }
        .geek .spinner { border-color: #002200; border-top-color: #33ff33; box-shadow: 0 0 8px rgba(51,255,51,0.4); }
        .geek .err-head { color: #ff3333; text-shadow: 0 0 8px #ff3333; }
        .geek .err-detail { color: #00b800; }
        .geek .caught-up { color: #33ff33; text-shadow: 0 0 12px #33ff33; }
        .geek .caught-up-sub { color: #00b800; }
        .geek .digest-footer { border-top-color: #002200; color: #007700; }
      `}</style>

      <div className={`digest-wrap${columns === 2 ? " two-col" : ""}${theme === "dark" ? " dark" : ""}${theme === "geek" ? " geek" : ""}`}>

        {/* ── Masthead ── */}
        <header className="masthead">
          <div className="masthead-top">
            <p className="masthead-meta">{TODAY}</p>
            <div className="masthead-actions">
              <button className={`hdr-btn${theme !== "light" ? " active" : ""}`} onClick={() => { const next = theme === "light" ? "dark" : theme === "dark" ? "geek" : "light"; setTheme(next); localStorage.setItem("digest:theme", next); }}>
                {theme === "geek" ? "☀ Light" : theme === "dark" ? "▣ Geek" : "☾ Dark"}
              </button>
              <div className="col-toggle">
                <button className={`col-btn${columns === 1 ? " active" : ""}`} onClick={() => { setColumns(1); localStorage.setItem("digest:columns", 1); }} title="Single column">▬</button>
                <button className={`col-btn${columns === 2 ? " active" : ""}`} onClick={() => { setColumns(2); localStorage.setItem("digest:columns", 2); }} title="Two columns">⊟</button>
              </div>
              <button className={`hdr-btn${showLibrary ? " active" : ""}`} onClick={() => { setShowLibrary(s => !s); setShowSources(false); setLibraryDay(null); }}>
                📚 Library
                {libraryDays.length > 0 && <span className="hdr-badge">{libraryDays.length}</span>}
              </button>
              <button className={`hdr-btn${showSources ? " active" : ""}`} onClick={() => { setShowSources(s => !s); setShowLibrary(false); setLibraryDay(null); }}>
                ⚙ Sources
                <span className="hdr-badge">{enabledCount}</span>
              </button>
            </div>
          </div>
          <h1 className="masthead-title">Morning Brief</h1>
          <hr className="masthead-rule-top" />
          <hr className="masthead-rule-thin" />
          <p className="masthead-sub">{sourcesLabel}</p>
          <p className="masthead-byline">By Rikard Zelin &amp; Claude</p>


        </header>

        {/* ── Sources panel ── */}
        {showSources && (
          <div className="panel">
            <p className="panel-title">Manage Sources</p>
            {feeds.map(feed => (
              <div className="feed-row" key={feed.id}>
                <label className="feed-toggle">
                  <input type="checkbox" checked={feed.enabled} onChange={() => toggleFeed(feed.id)} />
                  <div className="feed-toggle-track"><div className="feed-toggle-thumb" /></div>
                </label>
                <div className="feed-info">
                  <div className="feed-name">{feed.name}</div>
                  <div className="feed-url">{feed.url}</div>
                </div>
                <span className="feed-tag">{feed.tag}</span>
                {!feed.builtin && (
                  <button className="feed-remove" onClick={() => removeFeed(feed.id)} title="Remove">×</button>
                )}
              </div>
            ))}
            <div className="add-feed-form">
              <div className="add-feed-row">
                <input className="add-feed-input" placeholder="Source name (e.g. Krebs On Security)" value={newName} onChange={e => setNewName(e.target.value)} />
              </div>
              <div className="add-feed-row">
                <input className="add-feed-input" placeholder="RSS/Atom feed URL" value={newUrl} onChange={e => setNewUrl(e.target.value)} />
                <button className="add-feed-btn" onClick={addFeed}>Add</button>
              </div>
              {addError && <p className="add-feed-error">{addError}</p>}
            </div>

            {/* ── Clear data ── */}
            <div className="clear-data-section">
              <p className="clear-data-label">Reset</p>
              <div className="clear-data-row">
                <button className="clear-btn danger" onClick={() => {
                  clearSeenCache();
                  setClearMsg("Read history cleared — all articles will show as new.");
                  setTimeout(() => setClearMsg(""), 4000);
                }}>
                  Clear read history
                </button>
                <button className="clear-btn danger" onClick={() => {
                  localStorage.removeItem("digest:library_v1");
                  setLibrary({});
                  setClearMsg("Library cleared.");
                  setTimeout(() => setClearMsg(""), 4000);
                }}>
                  Clear library
                </button>
              </div>
              {clearMsg && <p style={{fontSize:"0.72rem", color:"#5a8a5a", marginTop:"0.6rem"}}>{clearMsg}</p>}
            </div>
          </div>
        )}

        {/* ── Library panel ── */}
        {showLibrary && (
          <div className="panel">
            {!libraryDay ? (
              <>
                <p className="panel-title">Past Digests</p>
                {libraryDays.length === 0
                  ? <p className="library-empty">No past digests yet — they'll appear here after your first fetch.</p>
                  : (
                    <div className="library-days">
                      {libraryDays.map(key => (
                        <button key={key} className={`library-day-btn${libraryDay === key ? " selected" : ""}`} onClick={() => openLibraryDay(key)}>
                          <span>{fmtLibraryDate(key)}</span>
                          <span className="library-day-stats">
                            {library[key].stats?.newCount || 0} articles · {library[key].stats?.topicCount || 0} topics
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                }
              </>
            ) : (
              <>
                <button className="library-back" onClick={() => setLibraryDay(null)}>← All dates</button>
                <p className="library-day-heading">{libraryEntry.date}</p>
                <p className="library-day-sub">{libraryEntry.stats?.newCount} articles · {libraryEntry.stats?.topicCount} topics</p>

                {/* Top 3 from that day */}
                {libraryEntry.top3?.length > 0 && (
                  <div style={{marginBottom:"1.8rem"}}>
                    <h2 className="top3-header"><span className="top3-star">★</span> Must-reads</h2>
                    <div className="top3-cards">
                      {libraryEntry.top3.map((item, i) => (
                        <div className="top3-card" key={item.id || i}>
                          <p className="top3-rank">#{i + 1} Must-read</p>
                          <div className="article-meta">
                            <span className="source-tag">{item.sourceTag}</span>
                            <span className="article-date">{fmtDate(item.pubDate)}</span>
                          </div>
                          <a className="article-title" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
                          <p className="article-summary">{item.summary}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Topic groups from that day */}
                {libraryEntry.groups?.map(({ topic, items }) => {
                  const collapsed = collapsedTopics.has(topic);
                  return (
                    <section className="topic-section" key={topic} style={{marginBottom:"1.8rem"}}>
                      <h2 className="topic-header" onClick={() => toggleTopic(topic)}>
                        {topic}<span className="topic-count">{items.length}</span>
                        <span className={`topic-chevron${collapsed ? " collapsed" : ""}`}>▾</span>
                      </h2>
                      {!collapsed && (
                        <div className="article-grid">
                          {items.map(item => (
                            <article className="article" key={item.id}>
                              <div className="article-meta">
                                <span className="source-tag">{item.sourceTag}</span>
                                <span className="article-date">{fmtDate(item.pubDate)}</span>
                              </div>
                              <a className="article-title" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
                              <p className="article-summary">{item.summary}</p>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* ── Idle ── */}
        {phase === "idle" && (
          <div className="idle-wrap">
            <p className="idle-greeting">Good morning.</p>
            <p className="idle-sub">
              Ready to fetch today's articles from {enabledCount} source{enabledCount !== 1 ? "s" : ""}<br />
              and summarise everything with AI.
            </p>
            <button className="fetch-btn" onClick={run}>Fetch Today's Brief</button>
          </div>
        )}

        {/* ── Loading ── */}
        {isLoading && (
          <div className="status-wrap">
            <div className="spinner" />
            <p className="status-label">{phase === "processing" ? "Summarising with AI…" : "Fetching feeds…"}</p>
          </div>
        )}

        {/* ── Error ── */}
        {phase === "error" && (
          <div className="status-wrap">
            <p className="err-head">Something went wrong</p>
            <p className="err-detail">{errMsg}</p>
            <button className="fetch-btn" onClick={run}>Try Again</button>
          </div>
        )}

        {/* ── All caught up ── */}
        {phase === "done" && stats?.newCount === 0 && (
          <div className="status-wrap">
            <p className="caught-up">You're all caught up.</p>
            <p className="caught-up-sub">No new articles since your last visit.</p>
            <button className="fetch-btn" onClick={run}>Check Again</button>
            {debugLog.length > 0 && (
              <div style={{marginTop:"1.8rem", textAlign:"left", maxWidth:"460px", margin:"1.8rem auto 0"}}>
                <p style={{fontSize:"0.6rem", letterSpacing:"0.15em", textTransform:"uppercase", color:"#9a8f7a", marginBottom:"0.5rem"}}>Fetch diagnostics</p>
                {debugLog.map((line, i) => (
                  <p key={i} style={{fontSize:"0.72rem", color: line.startsWith("✗") ? "#7a1e1e" : "#4a4132", lineHeight:"1.7", fontFamily:"monospace"}}>{line}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Results ── */}
        {phase === "done" && newGroups.length > 0 && (
          <>
            <div className="stats-bar">
              <span>{stats.newCount} new article{stats.newCount !== 1 ? "s" : ""}</span>
              <span>{stats.topicCount} topic{stats.topicCount !== 1 ? "s" : ""}</span>
            </div>

            {/* Top 3 must-reads */}
            {top3.length > 0 && (
              <div className="top3-section">
                <h2 className="top3-header"><span className="top3-star">★</span> Must-reads today</h2>
                <div className="top3-cards">
                {top3.map((item, i) => (
                  <div className="top3-card" key={item.id}>
                    <p className="top3-rank">#{i + 1} Must-read</p>
                    <div className="article-meta">
                      <span className="source-tag">{item.sourceTag}</span>
                      <span className="article-date">{fmtDate(item.pubDate)}</span>
                    </div>
                    <a className="article-title" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
                    <p className="article-summary">{item.summary}</p>
                  </div>
                ))}
                </div>
              </div>
            )}

            {/* All articles by topic */}
            {newGroups.map(({ topic, items }) => {
              const collapsed = collapsedTopics.has(topic);
              return (
                <section className="topic-section" key={topic}>
                  <h2 className="topic-header" onClick={() => toggleTopic(topic)}>
                    {topic}<span className="topic-count">{items.length}</span>
                    <span className={`topic-chevron${collapsed ? " collapsed" : ""}`}>▾</span>
                  </h2>
                  {!collapsed && (
                    <div className="article-grid">
                      {items.map(item => (
                        <article className="article" key={item.id}>
                          <div className="article-meta">
                            <span className="source-tag">{item.sourceTag}</span>
                            <span className="article-date">{fmtDate(item.pubDate)}</span>
                          </div>
                          <a className="article-title" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
                          <p className="article-summary">{item.summary}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}

        {/* ── Footer ── */}
        <footer className="digest-footer">
          <span>Morning Brief · Rikard Zelin &amp; Claude</span>
          {phase === "done" && <button className="refresh-btn" onClick={run}>Fetch Again</button>}
        </footer>
      </div>
    </>
  );
}
