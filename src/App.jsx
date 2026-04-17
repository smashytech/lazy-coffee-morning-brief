import { useState, useEffect, useRef } from "react";

// ─── Default feeds ─────────────────────────────────────────────────────────────
const DEFAULT_FEEDS = [
  { id: "thn", name: "The Hacker News",  url: "https://feeds.feedburner.com/TheHackersNews", tag: "THN", enabled: true, builtin: true },
  { id: "bc",  name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/",       tag: "BC",  enabled: true, builtin: true },
  { id: "rb",  name: "Risky Business",   url: "https://risky.biz/feeds/risky-business/",      tag: "RB",  enabled: true, builtin: true },
];

const FEEDS_KEY     = "digest:feeds_v1";
const SEEN_KEY      = "digest:seen_v2";
const LIBRARY_KEY   = "digest:library_v1";
const AI_CONFIG_KEY = "digest:ai_config_v1";

const SEEN_LIMIT    = 500;
const LIBRARY_LIMIT = 30;
const FEED_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS   = 60000;
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

function loadAiConfig() {
  const defaults = {
    provider: "anthropic",
    localUrl: "http://localhost:11434",
    model: "llama3",
    claudeModel: DEFAULT_CLAUDE_MODEL,
    apiKey: "",
  };
  try {
    const r = localStorage.getItem(AI_CONFIG_KEY);
    return { ...defaults, ...(r ? JSON.parse(r) : {}) };
  } catch { return defaults; }
}
function saveAiConfig(cfg) { localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg)); }

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
function saveSeen(s) {
  // Set preserves insertion order — keep the most recent IDs only.
  const arr = [...s];
  const trimmed = arr.length > SEEN_LIMIT ? arr.slice(arr.length - SEEN_LIMIT) : arr;
  localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
}

function loadLibrary() {
  try { const r = localStorage.getItem(LIBRARY_KEY); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
function saveLibrary(lib) {
  const keys = Object.keys(lib).sort().reverse();
  if (keys.length <= LIBRARY_LIMIT) {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
    return lib;
  }
  const keep = keys.slice(0, LIBRARY_LIMIT);
  const pruned = {};
  for (const k of keep) pruned[k] = lib[k];
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(pruned));
  return pruned;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function isRecent(dateStr) {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  const hours48ago = new Date(Date.now() - 48 * 60 * 60 * 1000);
  return d >= hours48ago;
}

function makeTag(name) {
  return name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 4) || "???";
}

// ─── fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, ms = FEED_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Request timed out after ${ms / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── RSS fetching ──────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  const res = await fetchWithTimeout(`/proxy?url=${encodeURIComponent(feed.url)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.name}`);
  const xml = await res.text();

  let doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    doc = new DOMParser().parseFromString(xml, "text/html");
  }

  // Use getElementsByTagName — it ignores namespace prefixes like <atom:entry>.
  let items = [...doc.getElementsByTagName("item")];
  if (items.length === 0) items = [...doc.getElementsByTagName("entry")];

  return items.slice(0, 12).map(item => {
    const getText = tag => item.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
    const linkEl = item.getElementsByTagName("link")[0];
    const link = linkEl?.getAttribute("href") || linkEl?.textContent?.trim() || getText("guid");
    const description =
      getText("description") || getText("summary") || getText("content") || getText("content:encoded");

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

// ─── Claude model pricing hints (input / output per million tokens) ────────────
const MODEL_PRICING = {
  "claude-opus-4-7":             "$15 in / $75 out per 1M tokens",
  "claude-opus-4-6":             "$15 in / $75 out per 1M tokens",
  "claude-opus-4-5":             "$15 in / $75 out per 1M tokens",
  "claude-opus-4-20250514":      "$15 in / $75 out per 1M tokens",
  "claude-sonnet-4-6":           "$3 in / $15 out per 1M tokens",
  "claude-sonnet-4-5":           "$3 in / $15 out per 1M tokens",
  "claude-sonnet-4-20250514":    "$3 in / $15 out per 1M tokens",
  "claude-haiku-4-5-20251001":   "$0.80 in / $4 out per 1M tokens",
  "claude-3-5-sonnet-20241022":  "$3 in / $15 out per 1M tokens",
  "claude-3-5-haiku-20241022":   "$0.80 in / $4 out per 1M tokens",
  "claude-3-opus-20240229":      "$15 in / $75 out per 1M tokens",
  "claude-3-sonnet-20240229":    "$3 in / $15 out per 1M tokens",
  "claude-3-haiku-20240307":     "$0.25 in / $1.25 out per 1M tokens",
};
function modelLabel(id) {
  if (MODEL_PRICING[id]) return `${id} (${MODEL_PRICING[id]})`;
  if (id.includes("opus"))   return `${id} ($15 in / $75 out per 1M tokens)`;
  if (id.includes("sonnet")) return `${id} ($3 in / $15 out per 1M tokens)`;
  if (id.includes("haiku"))  return `${id} ($0.80 in / $4 out per 1M tokens)`;
  return id;
}

// ─── AI: summarise + categorise + pick top 3 ──────────────────────────────────

const SYSTEM_PROMPT = `You are a cybersecurity news editor. Given a list of articles:

1. For each article write a 2–3 sentence plain-English summary and assign a short topic label (1–3 words, e.g. Ransomware, Vulnerabilities, Data Breach, Nation-State, Malware, Privacy, Podcast, Policy, Phishing, Cybercrime, AI Security, Zero-Day, Supply Chain).

2. Pick the 3 most important/newsworthy articles a security professional should read today. Use their index numbers.

3.  Do NOT start any sentence with "The article discusses", "This article", or similar phrases.

4.  Write in active voice, leading with the subject of the news.

Respond ONLY with a valid JSON object — no markdown fences, no extra text:
{
  "summaries": [{"index":0,"summary":"...","topic":"..."},...],
  "top3": [index1, index2, index3]
}`;

function parseAiJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  // Model sometimes wraps the JSON in prose — grab the first { ... } block.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`AI response was not valid JSON. First 200 chars: ${cleaned.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function aiProcess(items, aiConfig) {
  const payload = items.map((it, i) =>
    `[${i}] SOURCE: ${it.source}\nTITLE: ${it.title}\nBODY: ${it.description}`
  ).join("\n\n---\n\n");

  if (aiConfig?.provider === "local") {
    const res = await fetchWithTimeout(`/localllm?url=${encodeURIComponent(aiConfig.localUrl)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(aiConfig.apiKey ? { "Authorization": `Bearer ${aiConfig.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: payload },
        ],
        temperature: 0.3,
        stream: false,
      }),
    }, AI_TIMEOUT_MS);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Local LLM error ${res.status}`);
    }
    const data = await res.json();
    return parseAiJson(data.choices?.[0]?.message?.content || "");
  }

  const res = await fetchWithTimeout("/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: aiConfig.claudeModel || DEFAULT_CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: payload }],
    }),
  }, AI_TIMEOUT_MS);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `API error ${res.status}`;
    if (res.status === 401 || /api key/i.test(msg)) {
      throw new Error("Anthropic API key missing or invalid — check your .env file and restart the dev server.");
    }
    throw new Error(msg);
  }
  const data = await res.json();
  return parseAiJson(data.content.map(c => c.text || "").join(""));
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(str) {
  try { return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function fmtLibraryDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

// ─── Article card (shared by library and topic sections) ──────────────────────

function ArticleBody({ item }) {
  return (
    <>
      <div className="article-meta">
        <span className="source-tag">{item.sourceTag}</span>
        <span className="article-date">{fmtDate(item.pubDate)}</span>
      </div>
      <a className="article-title" href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a>
      <p className="article-summary">{item.summary}</p>
    </>
  );
}

function ArticleCard({ item }) {
  return <article className="article"><ArticleBody item={item} /></article>;
}

function TopicSection({ topic, items, collapsed, onToggle }) {
  return (
    <section className="topic-section">
      <button
        type="button"
        className="topic-header"
        aria-expanded={!collapsed}
        onClick={() => onToggle(topic)}
      >
        {topic}<span className="topic-count">{items.length}</span>
        <span className={`topic-chevron${collapsed ? " collapsed" : ""}`}>▾</span>
      </button>
      {!collapsed && (
        <div className="article-grid">
          {items.map(item => <ArticleCard key={item.id} item={item} />)}
        </div>
      )}
    </section>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DigestApp() {
  const initialEntry = loadLibrary()[todayKey()];
  const [phase,       setPhase]       = useState(() => initialEntry ? "done" : "idle");
  const [newGroups,   setNewGroups]   = useState(() => initialEntry?.groups || []);
  const [top3,        setTop3]        = useState(() => initialEntry?.top3   || []);
  const [stats,       setStats]       = useState(() => initialEntry?.stats  || null);
  const [errMsg,      setErrMsg]      = useState("");
  const [columns,     setColumns]     = useState(() => Number(localStorage.getItem("digest:columns")) || 1);
  const [theme,       setTheme]       = useState(() => {
    const t = localStorage.getItem("digest:theme");
    if (t) return t;
    return localStorage.getItem("digest:dark") === "1" ? "dark" : "light";
  });

  const [showSources, setShowSources] = useState(false);
  const [feeds,       setFeeds]       = useState(loadFeeds);
  const [newName,     setNewName]     = useState("");
  const [newUrl,      setNewUrl]      = useState("");
  const [addError,    setAddError]    = useState("");
  const [clearMsg,    setClearMsg]    = useState("");
  const [aiConfig,    setAiConfig]    = useState(loadAiConfig);
  const [claudeModels, setClaudeModels] = useState([]);
  const claudeModelsLoadedRef = useRef(false);
  const runningRef            = useRef(false);

  useEffect(() => {
    if (aiConfig.provider !== "anthropic") return;
    if (claudeModelsLoadedRef.current) return;
    claudeModelsLoadedRef.current = true;
    fetchWithTimeout("/anthropic/v1/models", {}, 8000)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const ids = (d?.data || []).map(m => m.id).filter(id => id.startsWith("claude-"));
        if (ids.length) setClaudeModels(ids);
      })
      .catch(() => { claudeModelsLoadedRef.current = false; });
  }, [aiConfig.provider]);

  const [debugLog,    setDebugLog]    = useState([]);
  const [collapsedTopics, setCollapsedTopics] = useState(new Set());

  const [showLibrary,  setShowLibrary]  = useState(false);
  const [library,      setLibrary]      = useState(loadLibrary);
  const [libraryDay,   setLibraryDay]   = useState(null);

  // ── Feed management ─────────────────────────────────────────────────────────

  function updateFeeds(next) { setFeeds(next); saveFeeds(next); }
  function updateAiConfig(next) { setAiConfig(next); saveAiConfig(next); }
  function toggleFeed(id)    { updateFeeds(feeds.map(f => f.id === id ? { ...f, enabled: !f.enabled } : f)); }
  function removeFeed(id)    { updateFeeds(feeds.filter(f => f.id !== id)); }

  async function addFeed() {
    setAddError("");
    const name = newName.trim(), url = newUrl.trim();
    if (!name || !url) { setAddError("Both name and URL are required."); return; }
    if (feeds.find(f => f.url === url)) { setAddError("This feed is already in your list."); return; }
    try {
      const res = await fetchWithTimeout(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`Got HTTP ${res.status}`);
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      if (doc.querySelector("parsererror")) throw new Error("Doesn't look like a valid RSS/Atom feed");
    } catch (e) { setAddError(`Couldn't load that feed: ${e.message}`); return; }

    const id = `custom_${Date.now()}`;
    updateFeeds([...feeds, { id, name, url, tag: makeTag(name), enabled: true, builtin: false }]);
    setNewName(""); setNewUrl("");
  }

  // ── Main fetch ──────────────────────────────────────────────────────────────

  async function run() {
    if (runningRef.current) return; // guard against double-click
    const activeFeeds = feeds.filter(f => f.enabled);
    if (activeFeeds.length === 0) {
      setErrMsg("No sources enabled. Open Sources to add or enable some.");
      setPhase("error"); return;
    }

    runningRef.current = true;
    setPhase("fetching"); setErrMsg(""); setNewGroups([]); setTop3([]); setStats(null);

    try {
      const seen = loadSeen();
      const fetchLog = [`Seen cache: ${seen.size} IDs`];
      let allItems = [];
      for (const feed of activeFeeds) {
        try {
          const items = await fetchFeed(feed);
          allItems = allItems.concat(items);
          fetchLog.push(`✓ ${feed.name}: ${items.length} items`);
        } catch (e) {
          fetchLog.push(`✗ ${feed.name}: ${e.message}`);
        }
      }

      // Deduplicate by id (O(n) via Map).
      const deduped = [...new Map(allItems.map(it => [it.id, it])).values()];
      const freshItems = deduped.filter(it => !seen.has(it.id)).slice(0, 24);
      fetchLog.push(`Total: ${deduped.length} | Fresh: ${freshItems.length}`);
      setDebugLog(fetchLog);

      let processed = [], pickedTop3 = [];
      if (freshItems.length > 0) {
        setPhase("processing");
        const aiResult = await aiProcess(freshItems, aiConfig);

        processed = (aiResult.summaries || [])
          .filter(r => r.index < freshItems.length)
          .map(r => ({ ...freshItems[r.index], summary: r.summary, topic: r.topic || "General" }));

        pickedTop3 = (aiResult.top3 || [])
          .map(idx => processed.find(p => p.id === freshItems[idx]?.id))
          .filter(Boolean)
          .slice(0, 3);
      }

      const map = {};
      processed.forEach(it => { (map[it.topic] = map[it.topic] || []).push(it); });
      const grouped = Object.entries(map)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([topic, items]) => ({ topic, items }));

      processed.forEach(it => seen.add(it.id));
      saveSeen(seen);

      if (processed.length > 0) {
        const lib = loadLibrary();
        lib[todayKey()] = {
          date: TODAY,
          groups: grouped,
          top3: pickedTop3,
          stats: { newCount: processed.length, topicCount: grouped.length },
        };
        const pruned = saveLibrary(lib);
        setLibrary(pruned);
      }

      setNewGroups(grouped);
      setTop3(pickedTop3);
      setStats({ newCount: processed.length, topicCount: grouped.length });
      setPhase("done");
    } catch (e) {
      console.error(e);
      setErrMsg(e.message || "Unknown error");
      setPhase("error");
    } finally {
      runningRef.current = false;
    }
  }

  // ── Library helpers ─────────────────────────────────────────────────────────

  const libraryDays  = Object.keys(library).sort().reverse();
  const libraryEntry = libraryDay ? library[libraryDay] : null;

  function toggleTopic(topic) {
    setCollapsedTopics(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic); else next.add(topic);
      return next;
    });
  }

  function openLibraryDay(key) { setLibraryDay(key); setShowSources(false); }

  const isLoading    = phase === "fetching" || phase === "processing";
  const enabledCount = feeds.filter(f => f.enabled).length;
  const sourcesLabel = feeds.filter(f => f.enabled).map(f => f.name).join(" · ") || "No sources enabled";
  const needsApiKey  = aiConfig.provider === "anthropic" && phase === "error" && /api key/i.test(errMsg);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`digest-wrap${columns === 2 ? " two-col" : ""}${theme === "dark" ? " dark" : ""}${theme === "geek" ? " geek" : ""}`}>

      <header className="masthead">
        <div className="masthead-top">
          <p className="masthead-meta">{TODAY}</p>
          <div className="masthead-actions">
            <button
              type="button"
              className={`hdr-btn${theme !== "light" ? " active" : ""}`}
              onClick={() => {
                const next = theme === "light" ? "dark" : theme === "dark" ? "geek" : "light";
                setTheme(next);
                localStorage.setItem("digest:theme", next);
              }}
            >
              {theme === "geek" ? "☀ Light" : theme === "dark" ? "▣ Geek" : "☾ Dark"}
            </button>
            <div className="col-toggle" role="group" aria-label="Column layout">
              <button type="button" className={`col-btn${columns === 1 ? " active" : ""}`} onClick={() => { setColumns(1); localStorage.setItem("digest:columns", 1); }} title="Single column" aria-label="Single column">▬</button>
              <button type="button" className={`col-btn${columns === 2 ? " active" : ""}`} onClick={() => { setColumns(2); localStorage.setItem("digest:columns", 2); }} title="Two columns" aria-label="Two columns">⊟</button>
            </div>
            <button type="button" className={`hdr-btn${showLibrary ? " active" : ""}`} onClick={() => { setShowLibrary(s => !s); setShowSources(false); setLibraryDay(null); }}>
              📚 Library
              {libraryDays.length > 0 && <span className="hdr-badge">{libraryDays.length}</span>}
            </button>
            <button type="button" className={`hdr-btn${showSources ? " active" : ""}`} onClick={() => { setShowSources(s => !s); setShowLibrary(false); setLibraryDay(null); }}>
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

      {needsApiKey && (
        <div className="key-banner">
          Your Anthropic API key looks missing or invalid. Check <code>.env</code>, then restart <code>npm run dev</code>.
        </div>
      )}

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
                <button type="button" className="feed-remove" onClick={() => removeFeed(feed.id)} title="Remove" aria-label={`Remove ${feed.name}`}>×</button>
              )}
            </div>
          ))}
          <div className="add-feed-form">
            <div className="add-feed-row">
              <input className="add-feed-input" placeholder="Source name (e.g. Krebs On Security)" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="add-feed-row">
              <input className="add-feed-input" placeholder="RSS/Atom feed URL" value={newUrl} onChange={e => setNewUrl(e.target.value)} />
              <button type="button" className="add-feed-btn" onClick={addFeed}>Add</button>
            </div>
            {addError && <p className="add-feed-error">{addError}</p>}
          </div>

          <div className="ai-section">
            <p className="ai-section-title">AI Provider</p>
            <div className="ai-provider-row">
              <button type="button" className={`ai-provider-btn${aiConfig.provider === "anthropic" ? " selected" : ""}`} onClick={() => updateAiConfig({ ...aiConfig, provider: "anthropic" })}>
                ☁ Anthropic (Claude)
              </button>
              <button type="button" className={`ai-provider-btn${aiConfig.provider === "local" ? " selected" : ""}`} onClick={() => updateAiConfig({ ...aiConfig, provider: "local" })}>
                🖥 Local LLM
              </button>
            </div>
            {aiConfig.provider === "anthropic" && (
              <>
                <p className="ai-field-label">Model</p>
                <div className="ai-field-row">
                  {claudeModels.length > 0
                    ? <select className="add-feed-input" value={aiConfig.claudeModel || ""} onChange={e => updateAiConfig({ ...aiConfig, claudeModel: e.target.value })}>
                        {claudeModels.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
                      </select>
                    : <input className="add-feed-input" placeholder={`e.g. ${DEFAULT_CLAUDE_MODEL}`} value={aiConfig.claudeModel || ""} onChange={e => updateAiConfig({ ...aiConfig, claudeModel: e.target.value })} />
                  }
                </div>
              </>
            )}
            {aiConfig.provider === "local" && (
              <>
                <p className="ai-field-label">Server URL</p>
                <div className="ai-field-row">
                  <input className="add-feed-input" placeholder="http://192.168.1.x:11434" value={aiConfig.localUrl} onChange={e => updateAiConfig({ ...aiConfig, localUrl: e.target.value })} />
                </div>
                <p className="ai-field-label">Model name</p>
                <div className="ai-field-row">
                  <input className="add-feed-input" placeholder="e.g. llama3, mistral, gemma3" value={aiConfig.model} onChange={e => updateAiConfig({ ...aiConfig, model: e.target.value })} />
                </div>
                <p className="ai-field-label">API Key <span style={{fontStyle:"italic", textTransform:"none", letterSpacing:0}}>(optional)</span></p>
                <div className="ai-field-row">
                  <input className="add-feed-input" type="password" placeholder="Leave blank if not required" value={aiConfig.apiKey || ""} onChange={e => updateAiConfig({ ...aiConfig, apiKey: e.target.value })} />
                </div>
                <p className="ai-help">
                  Works with Ollama (<code>ollama serve</code>) or Open-WebUI.<br/>
                  The server must be reachable from this machine.
                </p>
              </>
            )}
          </div>

          <div className="clear-data-section">
            <p className="clear-data-label">Reset</p>
            <div className="clear-data-row">
              <button type="button" className="clear-btn danger" onClick={() => {
                localStorage.removeItem(SEEN_KEY);
                setClearMsg("Read history cleared — all articles will show as new.");
                setTimeout(() => setClearMsg(""), 4000);
              }}>
                Clear read history
              </button>
              <button type="button" className="clear-btn danger" onClick={() => {
                localStorage.removeItem(LIBRARY_KEY);
                setLibrary({});
                setClearMsg("Library cleared.");
                setTimeout(() => setClearMsg(""), 4000);
              }}>
                Clear library
              </button>
            </div>
            {clearMsg && <p className="clear-msg">{clearMsg}</p>}
          </div>
        </div>
      )}

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
                      <button type="button" key={key} className="library-day-btn" onClick={() => openLibraryDay(key)}>
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
              <button type="button" className="library-back" onClick={() => setLibraryDay(null)}>← All dates</button>
              <p className="library-day-heading">{libraryEntry.date}</p>
              <p className="library-day-sub">{libraryEntry.stats?.newCount} articles · {libraryEntry.stats?.topicCount} topics</p>

              {libraryEntry.top3?.length > 0 && (
                <div style={{marginBottom:"1.8rem"}}>
                  <h2 className="top3-header"><span className="top3-star">★</span> Must-reads</h2>
                  <div className="top3-cards">
                    {libraryEntry.top3.map((item, i) => (
                      <div className="top3-card" key={item.id || i}>
                        <p className="top3-rank">#{i + 1} Must-read</p>
                        <ArticleBody item={item} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {libraryEntry.groups?.map(({ topic, items }) => (
                <TopicSection
                  key={topic}
                  topic={topic}
                  items={items}
                  collapsed={collapsedTopics.has(topic)}
                  onToggle={toggleTopic}
                />
              ))}
            </>
          )}
        </div>
      )}

      {phase === "idle" && (
        <div className="idle-wrap">
          <p className="idle-greeting">Good morning.</p>
          <p className="idle-sub">
            Ready to fetch today's articles from {enabledCount} source{enabledCount !== 1 ? "s" : ""}<br />
            and summarise everything with AI.
          </p>
          <button type="button" className="fetch-btn" onClick={run} disabled={isLoading}>Fetch Today's Brief</button>
        </div>
      )}

      {isLoading && (
        <div className="status-wrap">
          <div className="spinner" />
          <p className="status-label">{phase === "processing" ? "Summarising with AI…" : "Fetching feeds…"}</p>
        </div>
      )}

      {phase === "error" && (
        <div className="status-wrap">
          <p className="err-head">Something went wrong</p>
          <p className="err-detail">{errMsg}</p>
          <button type="button" className="fetch-btn" onClick={run} disabled={isLoading}>Try Again</button>
        </div>
      )}

      {phase === "done" && stats?.newCount === 0 && (
        <div className="status-wrap">
          <p className="caught-up">You're all caught up.</p>
          <p className="caught-up-sub">No new articles since your last visit.</p>
          <button type="button" className="fetch-btn" onClick={run} disabled={isLoading}>Check Again</button>
          {debugLog.length > 0 && (
            <div className="diagnostics">
              <p className="diagnostics-label">Fetch diagnostics</p>
              {debugLog.map((line, i) => (
                <p key={i} className={`diagnostics-line${line.startsWith("✗") ? " fail" : ""}`}>{line}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {phase === "done" && newGroups.length > 0 && (
        <>
          <div className="stats-bar">
            <span>{stats.newCount} new article{stats.newCount !== 1 ? "s" : ""}</span>
            <span>{stats.topicCount} topic{stats.topicCount !== 1 ? "s" : ""}</span>
          </div>

          {top3.length > 0 && (
            <div className="top3-section">
              <h2 className="top3-header"><span className="top3-star">★</span> Must-reads today</h2>
              <div className="top3-cards">
                {top3.map((item, i) => (
                  <div className="top3-card" key={item.id}>
                    <p className="top3-rank">#{i + 1} Must-read</p>
                    <ArticleBody item={item} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {newGroups.map(({ topic, items }) => (
            <TopicSection
              key={topic}
              topic={topic}
              items={items}
              collapsed={collapsedTopics.has(topic)}
              onToggle={toggleTopic}
            />
          ))}
        </>
      )}

      <footer className="digest-footer">
        <span>Morning Brief · Rikard Zelin &amp; Claude</span>
        {phase === "done" && <button type="button" className="refresh-btn" onClick={run} disabled={isLoading}>Fetch Again</button>}
      </footer>
    </div>
  );
}
