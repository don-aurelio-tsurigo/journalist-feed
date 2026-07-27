export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
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

// ---------------------------------------------------------------------------
// Tsüri-Stilguide für die Artikel-Entwürfe. Beschreibt Ton und Struktur,
// enthält bewusst keine wörtlichen Zitate aus echten Artikeln.
// ---------------------------------------------------------------------------
const TSURI_STYLE_GUIDE = `
Du schreibst einen kurzen Artikelentwurf für Tsüri.ch, das unabhängige
Stadtmagazin für Zürich. Halte dich an diesen Stil:

- Zielpublikum: Zürcher:innen, die direkt angesprochen werden ("du"), nicht
  "man" oder "die Leser".
- Durchgängig gendern mit Doppelpunkt (z.B. "Bewohner:innen", "Politiker:innen").
- Lead-Satz zuerst: worum geht's, was steht auf dem Spiel, warum ist es für
  Zürich relevant. Kein "Die Stadt Zürich teilt mit, dass..." als Einstieg.
- Sachlich-direkt, ohne Boulevard-Übertreibung, aber pointiert und mit klarer
  Haltung, wo angebracht. Bei Blaulicht-Themen nüchtern und faktenbasiert,
  keine reisserische Sprache.
- Kurze Sätze, aktive Verben, keine Behördensprache/Amtsdeutsch übernehmen -
  in eigenen Worten erklären, was es für die Stadt/die Leute bedeutet.
- Länge: 120-220 Wörter, 2-4 Absätze.
- Am Schluss falls sinnvoll: ein Satz Einordnung/Kontext (was folgt daraus,
  was ist offen).
- Erfinde keine Fakten, Zahlen oder Zitate, die nicht in der Vorlage stehen.
  Wenn Informationen fehlen, lass die Lücke oder formuliere vorsichtig
  ("laut Mitteilung", "unklar bleibt...").
- Gib nur den Artikeltext zurück, keine Überschrift-Präfixe wie "Titel:",
  keine Meta-Kommentare.
`.trim();

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
// Artikel-Entwurf via Claude
// ---------------------------------------------------------------------------

async function fetchFullText(link: string): Promise<string> {
  try {
    const res = await fetch(link, { headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" } });
    if (!res.ok) return "";
    const html = await res.text();
    return extractMainText(html);
  } catch {
    return "";
  }
}

// Grobe, abhängigkeitsfreie Extraktion: Scripts/Styles raus, Tags raus,
// Whitespace kollabieren. Kein sauberes Readability-Parsing, reicht aber
// als Rohtext-Grundlage für den Prompt.
function extractMainText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 8000);
}

async function generateDraft(env: Env, item: any): Promise<string> {
  const fullText = await fetchFullText(item.link);
  const sourceText = fullText || item.summary || item.title;

  const userPrompt = `Quelle: ${item.source_label}
Titel der Meldung: ${item.title}
Link: ${item.link}

Volltext/Auszug der Meldung:
"""
${sourceText}
"""

Schreib daraus einen Tsüri.ch-Artikelentwurf gemäss Stilguide.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      system: TSURI_STYLE_GUIDE,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock?.text?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Prüft serverseitig (ohne Browser-CORS-Einschränkungen), ob eine Seite sich
// per iFrame einbetten lässt. Browser können das selbst nicht zuverlässig
// erkennen, weil sie den Fehler nur intern anzeigen (z.B. Firefox' eigene
// "darf nicht öffnen"-Seite lädt "erfolgreich" innerhalb des iFrames).
// ---------------------------------------------------------------------------
async function checkEmbeddable(target: string): Promise<boolean> {
  try {
    let res = await fetch(target, {
      method: "HEAD",
      headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" },
    });
    // Manche Server unterstützen kein HEAD -> auf GET zurückfallen, Body verwerfen.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(target, {
        method: "GET",
        headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" },
      });
      res.body?.cancel();
    }

    const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
    if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;

    const csp = (res.headers.get("content-security-policy") || "").toLowerCase();
    const frameAncestorsMatch = csp.match(/frame-ancestors\s+([^;]+)/);
    if (frameAncestorsMatch) {
      const value = frameAncestorsMatch[1].trim();
      if (value === "'none'" || value === "'self'") return false;
    }

    return true;
  } catch {
    // Bei Fehlern (Timeout, Netzwerk) im Zweifel embeddable annehmen -
    // das Frontend hat ohnehin noch den Zeit-Fallback als zweite Absicherung.
    return true;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };

  if (url.pathname === "/api/sources" && request.method === "GET") {
    return new Response(JSON.stringify(SOURCES.map((s) => ({ key: s.key, label: s.label }))), { headers });
  }

  if (url.pathname === "/api/check-embeddable" && request.method === "GET") {
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response(JSON.stringify({ error: "url fehlt" }), { status: 400, headers });
    }
    const embeddable = await checkEmbeddable(target);
    return new Response(JSON.stringify({ embeddable }), { headers });
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

  const draftMatch = url.pathname.match(/^\/api\/items\/(.+)\/draft$/);
  if (draftMatch && request.method === "POST") {
    const id = decodeURIComponent(draftMatch[1]);
    const item = await env.DB.prepare("SELECT * FROM news_items WHERE id = ?").bind(id).first();
    if (!item) {
      return new Response(JSON.stringify({ error: "Item nicht gefunden" }), { status: 404, headers });
    }
    try {
      const draft = await generateDraft(env, item);
      const generatedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE news_items SET draft_text = ?, draft_generated_at = ? WHERE id = ?")
        .bind(draft, generatedAt, id)
        .run();
      return new Response(JSON.stringify({ ok: true, draft_text: draft, draft_generated_at: generatedAt }), { headers });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 502, headers });
    }
  }

  if (url.pathname === "/api/run" && request.method === "POST") {
    const results = await runFetchCycle(env);
    return new Response(JSON.stringify({ ok: true, results }), { headers });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
}
