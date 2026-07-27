export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

interface NewsItem {
  id: string;
  source: string;
  source_label: string;
  title: string;
  link: string;
  summary: string;
  published_at: string | null;
}

interface FeedSource {
  key: string;
  label: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Quellen
//
// WICHTIG: Die URL für die Stadtpolizei ist nach dem gleichen CMS-Muster wie
// die Medienmitteilungen abgeleitet (…/_jcr_content/mainparsys/teaser.rss),
// aber NICHT verifiziert. Bitte vor dem ersten Deploy einmal im Browser auf
// https://www.stadt-zuerich.ch/de/politik-und-verwaltung/stadtverwaltung/sid/stapo.html
// auf "RSS-Feed abonnieren" klicken und die echte URL hier eintragen.
// ---------------------------------------------------------------------------
const SOURCES: FeedSource[] = [
  {
    key: "stadt-zuerich-medienmitteilungen",
    label: "Stadt Zürich – Medienmitteilungen",
    url: "https://www.stadt-zuerich.ch/de/aktuell/medienmitteilungen/_jcr_content/mainparsys/teaser.rss",
  },
  {
    key: "stadtpolizei-zuerich",
    label: "Stadtpolizei Zürich",
    url: "https://www.stadt-zuerich.ch/de/politik-und-verwaltung/stadtverwaltung/sid/stapo/_jcr_content/mainparsys/teaser.rss", // TODO: verifizieren
  },
];

// Baugesuche Kanton Zürich (opendata.swiss) sind als GPKG (Geopackage)
// publiziert, kein einfaches RSS/CSV. Das lohnt sich als eigener zweiter
// Schritt (Parsing via Python/GDAL oder Prüfung ob ein CSV/GeoJSON-Resource
// existiert) - hier bewusst noch nicht eingebaut, um das Grundgerüst schlank
// zu halten.

const ALLOWED_STATUSES = ["neu", "interessant", "beobachten", "verworfen"];

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runFetchCycle(env));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// Fetch-Zyklus
// ---------------------------------------------------------------------------

async function runFetchCycle(env: Env): Promise<{ source: string; count: number; error?: string }[]> {
  const results: { source: string; count: number; error?: string }[] = [];
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" },
      });
      if (!res.ok) {
        results.push({ source: source.key, count: 0, error: `HTTP ${res.status}` });
        continue;
      }
      const xml = await res.text();
      const items = parseRss(xml, source.key, source.label);
      await upsertItems(env, items);
      results.push({ source: source.key, count: items.length });
    } catch (err: any) {
      results.push({ source: source.key, count: 0, error: String(err?.message ?? err) });
    }
  }
  return results;
}

async function upsertItems(env: Env, items: NewsItem[]) {
  const fetchedAt = new Date().toISOString();
  for (const item of items) {
    await env.DB.prepare(
      `INSERT INTO news_items (id, source, source_label, title, link, summary, published_at, fetched_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'neu')
       ON CONFLICT(id) DO NOTHING`
    )
      .bind(
        item.id,
        item.source,
        item.source_label,
        item.title,
        item.link,
        item.summary,
        item.published_at,
        fetchedAt
      )
      .run();
  }
}

// ---------------------------------------------------------------------------
// Sehr schlanker RSS-Parser (regex-basiert, ohne externe Abhängigkeiten)
// Reicht für standardkonforme RSS 2.0 Feeds wie die von stadt-zuerich.ch.
// ---------------------------------------------------------------------------

function parseRss(xml: string, sourceKey: string, sourceLabel: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = clean(extractTag(block, "title"));
    const link = clean(extractTag(block, "link"));
    const description = clean(extractTag(block, "description"));
    const pubDate = extractTag(block, "pubDate");
    const guid = clean(extractTag(block, "guid")) || link;

    if (!link || !title) continue;

    items.push({
      id: `${sourceKey}::${guid}`.slice(0, 500),
      source: sourceKey,
      source_label: sourceLabel,
      title,
      link,
      summary: description.slice(0, 600),
      published_at: safeDate(pubDate),
    });
  }

  return items;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const found = block.match(re);
  return found ? found[1].trim() : "";
}

function clean(raw: string): string {
  const withoutCdata = raw.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  return decodeEntities(withoutCdata).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function safeDate(pubDate: string): string | null {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };

  if (url.pathname === "/api/sources" && request.method === "GET") {
    return new Response(JSON.stringify(SOURCES.map((s) => ({ key: s.key, label: s.label }))), { headers });
  }

  if (url.pathname === "/api/items" && request.method === "GET") {
    const status = url.searchParams.get("status");
    const source = url.searchParams.get("source");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);

    let query = "SELECT * FROM news_items WHERE 1=1";
    const binds: unknown[] = [];
    if (status) {
      query += " AND status = ?";
      binds.push(status);
    }
    if (source) {
      query += " AND source = ?";
      binds.push(source);
    }
    query += " ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?";
    binds.push(limit);

    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return new Response(JSON.stringify(results), { headers });
  }

  const statusMatch = url.pathname.match(/^\/api\/items\/(.+)\/status$/);
  if (statusMatch && request.method === "POST") {
    const id = decodeURIComponent(statusMatch[1]);
    const body = (await request.json()) as { status?: string };
    if (!body.status || !ALLOWED_STATUSES.includes(body.status)) {
      return new Response(JSON.stringify({ error: "Ungültiger Status" }), { status: 400, headers });
    }
    await env.DB.prepare("UPDATE news_items SET status = ? WHERE id = ?").bind(body.status, id).run();
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (url.pathname === "/api/run" && request.method === "POST") {
    const results = await runFetchCycle(env);
    return new Response(JSON.stringify({ ok: true, results }), { headers });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
}
