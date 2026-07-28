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
  {
    key: "gemeinderat-zuerich",
    label: "Gemeinderat Zürich",
    url: "https://www.gemeinderat-zuerich.ch/de/geschaefte/export.php?export=rss",
  },
  {
    key: "tagesanzeiger-zuerich",
    label: "Tages-Anzeiger Zürich",
    url: "https://partner-feeds.publishing.tamedia.ch/rss/tagesanzeiger/zuerich",
  },
  {
    key: "20min-zuerich",
    label: "20 Minuten Zürich",
    url: "https://partner-feeds.20min.ch/rss/20minuten/regionen/zuerich",
  },
];

// Tagblatt der Stadt Zürich hat kein RSS - wird per HTML-Scraping der
// Übersichtsseite geholt. Kein robots.txt-Verbot, keine Paywall. Die
// Extraktion ist heuristisch (Regex auf Anker-Links zur Detailseite,
// gruppiert nach News-ID), da uns die exakte HTML-Struktur nicht aus
// erster Hand vorliegt - ggf. nach dem ersten Testlauf nachjustieren.
const TAGBLATT_SOURCE = { key: "tagblatt-zuerich", label: "Tagblatt der Stadt Zürich" };
const TAGBLATT_URL = "https://www.tagblattzuerich.ch/zuerich";

// Der Gemeinderat-Feed ist komplett ungefiltert (geht Jahre zurück, tausende
// Einträge). Ohne Cutoff würde ein einzelner Sync-Durchlauf zu lange dauern
// bzw. das Worker-Zeitlimit sprengen - daher nur Geschäfte der letzten X Tage
// übernehmen. Läuft der Cron alle 15 Min, reicht ein moderater Puffer.
const GEMEINDERAT_MAX_AGE_DAYS = 45;

// Baugesuche Stadt Zürich via die offene Amtsblattportal-API (kein Login
// nötig für publizierte Meldungen). Wichtig: nicht "rubrics=BP" (liefert
// nichts), sondern die Subrubrik "BP-ZH01" ("Kommunales Bauprojekt" im
// Tenant kabzh). Das Feld "registrationOfficeTown" wird client-seitig auf
// "Zürich" gefiltert, weil die Subrubrik den ganzen Kanton umfasst, nicht
// nur die Stadt. "titleDe" aus der Bulk-CSV liefert bereits einen Titel mit
// Adresse; die echte Projektbeschreibung + Kreis stecken nur in der
// Einzel-Publikations-XML und werden pro Item zusätzlich nachgeladen.
const BAUGESUCHE_SOURCE = { key: "baugesuche-zh", label: "Baugesuche Stadt Zürich" };
const BAUGESUCHE_MAX_AGE_DAYS = 30;
const BAUGESUCHE_TOWN = "Zürich";

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
- Sachlich-direkt, ohne Boulevard-Übertreibung, aber pointiert und mit klarer
  Haltung, wo angebracht. Bei Blaulicht-Themen nüchtern und faktenbasiert,
  keine reisserische Sprache.
- Kurze Sätze, aktive Verben, keine Behördensprache/Amtsdeutsch übernehmen -
  in eigenen Worten erklären, was es für die Stadt/die Leute bedeutet.
- Erfinde keine Fakten, Zahlen oder Zitate, die nicht in der Vorlage stehen.
  Wenn Informationen fehlen, lass die Lücke oder formuliere vorsichtig
  ("laut Mitteilung", "unklar bleibt...").

Du lieferst drei Teile:
- title: eine prägnante, konkrete Schlagzeile (keine Frage, kein Clickbait,
  nennt worum es geht). Maximal ca. 12 Wörter.
- lead: 1-2 Sätze, die Kern und Relevanz auf den Punkt bringen - das, was
  jemand liest, bevor er entscheidet weiterzulesen. Kein "Die Stadt Zürich
  teilt mit, dass..." als Einstieg.
- body: der Fliesstext, 120-220 Wörter, 2-4 Absätze, baut auf dem Lead auf
  und liefert die Details. Am Schluss falls sinnvoll ein Satz Einordnung
  (was folgt daraus, was ist offen).

Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Objekt in diesem Format,
ohne Markdown-Codeblock, ohne Erklärungen davor oder danach. Absätze im
body als "\\n\\n" (JSON-Escape-Sequenz), NIEMALS als echten Zeilenumbruch,
sonst ist das JSON ungültig:
{"title": "...", "lead": "...", "body": "Absatz eins.\\n\\nAbsatz zwei."}
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

  // Baugesuche ist keine RSS-Quelle, separat behandelt.
  try {
    const items = await fetchBaugesuche();
    await upsertItems(env, items);
    results.push({ source: BAUGESUCHE_SOURCE.key, count: items.length });
  } catch (err: any) {
    results.push({ source: BAUGESUCHE_SOURCE.key, count: 0, error: String(err?.message ?? err) });
  }

  // Tagblatt der Stadt Zürich: HTML-Scraping statt RSS.
  try {
    const items = await fetchTagblatt();
    await upsertItems(env, items);
    results.push({ source: TAGBLATT_SOURCE.key, count: items.length });
  } catch (err: any) {
    results.push({ source: TAGBLATT_SOURCE.key, count: 0, error: String(err?.message ?? err) });
  }

  return results;
}

async function fetchTagblatt(): Promise<NewsItem[]> {
  const res = await fetch(TAGBLATT_URL, { headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" } });
  if (!res.ok) throw new Error(`Tagblatt HTTP ${res.status}`);
  const html = await res.text();
  return parseTagblattHtml(html);
}

// Heuristischer Scraper: TYPO3-News-Detaillinks enthalten alle das Muster
// "tx_news_pi1[action]=detail...[news]=<ID>". Jede News-ID taucht mehrfach
// auf (Bild-Link, Titel-Link, "Weiterlesen"-Link) - wir sammeln pro ID alle
// Anker-Texte und wählen den kürzesten sinnvollen als Titel (Schlagzeile)
// und den längsten als Teaser/Summary. Datum wird best-effort per
// Positions-Zuordnung ("Aktuell TT.MM.JJJJ - HH:MM") zugewiesen.
function parseTagblattHtml(html: string): NewsItem[] {
  const linkRegex =
    /<a\b[^>]*href="([^"]*tx_news_pi1%5Baction%5D=detail[^"]*news%5D=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const byId = new Map<string, { url: string; texts: string[] }>();
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const id = match[2];
    const text = clean(match[3].replace(/<[^>]+>/g, " "));
    const url = decodeEntities(rawUrl);
    if (!byId.has(id)) byId.set(id, { url, texts: [] });
    if (text) byId.get(id)!.texts.push(text);
  }

  // Datumsangaben in Dokumentreihenfolge einsammeln, um sie später
  // positionsbasiert den Artikeln zuzuordnen (best effort).
  const dateMatches = [...html.matchAll(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2}):(\d{2})/g)];
  const orderedIds = [...byId.keys()]; // Map bewahrt Einfügereihenfolge = Dokumentreihenfolge
  const datesById = new Map<string, string>();
  if (dateMatches.length === orderedIds.length) {
    orderedIds.forEach((id, i) => {
      const [, day, month, year, hour, minute] = dateMatches[i];
      const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
      if (!isNaN(d.getTime())) datesById.set(id, d.toISOString());
    });
  }

  const items: NewsItem[] = [];
  for (const [id, { url, texts }] of byId) {
    const candidates = [...new Set(texts)].filter(
      (t) => t.toLowerCase() !== "weiterlesen" && t.length > 2
    );
    if (candidates.length === 0) continue;
    const sorted = [...candidates].sort((a, b) => a.length - b.length);
    const title = sorted[0];
    const summary = sorted[sorted.length - 1] === title ? "" : sorted[sorted.length - 1];

    items.push({
      id: `${TAGBLATT_SOURCE.key}::${id}`,
      source: TAGBLATT_SOURCE.key,
      source_label: TAGBLATT_SOURCE.label,
      title,
      link: url,
      summary: summary.slice(0, 600),
      published_at: datesById.get(id) ?? null,
    });
  }
  return items;
}

async function fetchBaugesuche(): Promise<NewsItem[]> {
  const cutoff = new Date(Date.now() - BAUGESUCHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  const sortParam = encodeURIComponent("column:PUBLICATION_DATE|direction:DESC");
  const url =
    `https://amtsblattportal.ch/api/v1/publications/csv?publicationStates=PUBLISHED` +
    `&subRubrics=BP-ZH01&publicationDate.start=${cutoffStr}` +
    `&pageRequest.sortOrders=${sortParam}&pageRequest.size=200`;

  const res = await fetch(url, { headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" } });
  if (!res.ok) throw new Error(`Amtsblattportal API ${res.status}`);
  const csvText = await res.text();
  const baseItems = parseBaugesucheCsv(csvText);

  // Für jedes Stadt-Zürich-Baugesuch die Einzel-Publikation nachladen, um
  // die echte Projektbeschreibung + Kreis/Bauzone zu bekommen (steckt nicht
  // in der Bulk-CSV-Liste, nur in der Einzel-Publikations-XML). Fehler bei
  // einzelnen Items werden toleriert - dann bleibt der Basis-Titel stehen.
  const enriched = await Promise.all(
    baseItems.map(async (item) => {
      const publicationId = item.id.split("::")[1];
      const details = await fetchBaugesucheDetails(publicationId);
      if (!details) return item;
      const parts = [details.projectDescription, details.district ? `Kreis: ${details.district}` : ""].filter(
        Boolean
      );
      return { ...item, summary: parts.join(" · ") || item.summary };
    })
  );

  return enriched;
}

interface BaugesucheDetails {
  projectDescription: string;
  district: string;
}

async function fetchBaugesucheDetails(publicationId: string): Promise<BaugesucheDetails | null> {
  try {
    const res = await fetch(`https://amtsblattportal.ch/api/v1/publications/${publicationId}/xml`, {
      headers: { "User-Agent": "TsueriNewsFeed/1.0 (+https://tsri.ch)" },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const projectDescription = clean(extractTag(xml, "projectDescription"));
    const district = clean(extractTag(xml, "district"));
    if (!projectDescription && !district) return null;
    return { projectDescription, district };
  } catch {
    return null;
  }
}

// Vollwertiger CSV-Parser (kein naives Line-Splitting!): Felder können in
// Anführungszeichen echte Zeilenumbrüche enthalten (z.B. "legalRemedy"),
// daher muss der ganze Text zeichenweise durchlaufen werden statt vorher
// nach "\n" zu splitten.
function parseCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// Filtert clientseitig auf Stadt Zürich, da die Subrubrik BP-ZH01 den
// ganzen Kanton umfasst.
function parseBaugesucheCsv(csv: string): NewsItem[] {
  const records = parseCsvRecords(csv, ";").filter((r) => r.some((cell) => cell.trim() !== ""));
  if (records.length < 2) return [];

  const headers = records[0].map((h) => h.trim().toLowerCase());
  const idIdx = headers.indexOf("id");
  const dateIdx = headers.indexOf("publicationdate");
  const numberIdx = headers.indexOf("publicationnumber");
  const townIdx = headers.indexOf("registrationofficetown");
  const officeIdx = headers.indexOf("registrationofficedisplayname");
  const titleDeIdx = headers.indexOf("titlede");

  if (idIdx < 0) return []; // Unerwartetes CSV-Format - lieber nichts als Falsches liefern

  const items: NewsItem[] = [];
  for (let i = 1; i < records.length; i++) {
    const cols = records[i];
    const id = cols[idIdx]?.trim();
    if (!id) continue;

    const town = townIdx >= 0 ? cols[townIdx]?.trim() : "";
    if (town !== BAUGESUCHE_TOWN) continue; // nur Stadt Zürich, nicht ganzer Kanton

    const dateRaw = dateIdx >= 0 ? cols[dateIdx]?.trim() : "";
    const publishedAt = dateRaw ? safeDate(dateRaw) : null;
    const publicationNumber = numberIdx >= 0 ? cols[numberIdx]?.trim() : id.slice(0, 8);
    const titleDe = titleDeIdx >= 0 ? cols[titleDeIdx]?.trim() : "";
    const office = officeIdx >= 0 ? cols[officeIdx]?.trim() : "";

    items.push({
      id: `${BAUGESUCHE_SOURCE.key}::${id}`.slice(0, 500),
      source: BAUGESUCHE_SOURCE.key,
      source_label: BAUGESUCHE_SOURCE.label,
      title: titleDe || `Baugesuch publiziert – Zürich (Nr. ${publicationNumber})`,
      link: `https://amtsblattportal.ch/api/v1/publications/${id}/pdf`,
      summary: office ? `Zuständige Stelle: ${office}` : "",
      published_at: publishedAt,
    });
  }
  return items;
}

async function upsertItems(env: Env, items: NewsItem[]) {
  if (items.length === 0) return;
  const fetchedAt = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO news_items (id, source, source_label, title, link, summary, published_at, fetched_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'neu')
     ON CONFLICT(id) DO NOTHING`
  );
  // Batch statt einzelner sequentieller awaits - bei grösseren Feeds
  // (z.B. Gemeinderat) sonst zu langsam / riskiert das Worker-Zeitlimit.
  const batchSize = 50;
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await env.DB.batch(
      chunk.map((item) =>
        stmt.bind(
          item.id,
          item.source,
          item.source_label,
          item.title,
          item.link,
          item.summary,
          item.published_at,
          fetchedAt
        )
      )
    );
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
  const isGemeinderat = sourceKey === "gemeinderat-zuerich";
  const cutoff = isGemeinderat ? Date.now() - GEMEINDERAT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000 : null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    let title = clean(extractTag(block, "title"));
    const link = clean(extractTag(block, "link"));
    const description = clean(extractTag(block, "description"));
    const pubDateRaw = extractTag(block, "pubDate");
    const guid = clean(extractTag(block, "guid")) || link;

    if (!link || !title) continue;

    let publishedAt: string | null;
    let summary: string;

    if (isGemeinderat) {
      // Format hier: "TT.MM.JJJJ" statt RFC-822, und <description> ist eine
      // Geschäftsnummer (z.B. "2026/400"), keine Zusammenfassung - daher als
      // Präfix in den Titel, statt als Summary anzuzeigen.
      publishedAt = parseSwissDate(pubDateRaw);
      if (description) title = `${description} – ${title}`;
      summary = "";
      if (cutoff !== null) {
        const ts = publishedAt ? new Date(publishedAt).getTime() : null;
        if (ts === null || ts < cutoff) continue; // zu alt, überspringen
      }
    } else {
      publishedAt = safeDate(pubDateRaw);
      summary = description.slice(0, 600);
    }

    items.push({
      id: `${sourceKey}::${guid}`.slice(0, 500),
      source: sourceKey,
      source_label: sourceLabel,
      title,
      link,
      summary,
      published_at: publishedAt,
    });
  }

  return items;
}

// Parst "TT.MM.JJJJ" (Schweizer Datumsformat), das new Date() nicht
// zuverlässig versteht.
function parseSwissDate(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, day, month, year] = m;
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return isNaN(d.getTime()) ? null : d.toISOString();
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

interface DraftResult {
  title: string;
  lead: string;
  body: string;
}

async function generateDraft(env: Env, item: any): Promise<DraftResult> {
  // Bei Baugesuche ist der Link ein PDF, kein HTML - fetchFullText würde
  // dort nur Binär-Kauderwelsch liefern. Die Summary enthält hier bereits
  // die echte Projektbeschreibung aus der Einzel-Publikations-XML, die
  // reicht als Quelle.
  const fullText = item.source === "baugesuche-zh" ? "" : await fetchFullText(item.link);
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
      max_tokens: 1200,
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
  const raw = (textBlock?.text ?? "").trim();

  return parseDraftJson(raw);
}

// Erwartet JSON von Claude, räumt vorsichtshalber mögliche Markdown-Codefences
// weg und fällt bei Parse-Fehlern darauf zurück, den Rohtext als body zu
// nehmen statt komplett zu scheitern.
function parseDraftJson(raw: string): DraftResult {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    return finishParse(cleaned);
  } catch {
    // Häufigste Fehlerursache: Claude setzt bei mehreren Absätzen echte
    // Zeilenumbrüche statt der JSON-Escape-Sequenz "\n" in die Strings -
    // das bricht JSON.parse. Reparieren, indem verbleibende rohe
    // Zeilenumbrüche zur Escape-Sequenz umgewandelt werden, dann erneut
    // versuchen.
    try {
      const repaired = cleaned.replace(/\r\n|\r|\n/g, "\\n");
      return finishParse(repaired);
    } catch {
      return { title: "", lead: "", body: raw };
    }
  }
}

function finishParse(jsonText: string): DraftResult {
  const parsed = JSON.parse(jsonText);
  return {
    title: String(parsed.title ?? "").trim(),
    lead: String(parsed.lead ?? "").trim(),
    body: String(parsed.body ?? "").trim(),
  };
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
    const all = [...SOURCES.map((s) => ({ key: s.key, label: s.label })), BAUGESUCHE_SOURCE, TAGBLATT_SOURCE];
    return new Response(JSON.stringify(all), { headers });
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

  const draftDiscardMatch = url.pathname.match(/^\/api\/items\/(.+)\/draft\/discard$/);
  if (draftDiscardMatch && request.method === "POST") {
    const id = decodeURIComponent(draftDiscardMatch[1]);
    await env.DB.prepare(
      "UPDATE news_items SET draft_title = NULL, draft_lead = NULL, draft_text = NULL, draft_generated_at = NULL WHERE id = ?"
    )
      .bind(id)
      .run();
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
      await env.DB.prepare(
        "UPDATE news_items SET draft_title = ?, draft_lead = ?, draft_text = ?, draft_generated_at = ? WHERE id = ?"
      )
        .bind(draft.title, draft.lead, draft.body, generatedAt, id)
        .run();
      return new Response(
        JSON.stringify({
          ok: true,
          draft_title: draft.title,
          draft_lead: draft.lead,
          draft_text: draft.body,
          draft_generated_at: generatedAt,
        }),
        { headers }
      );
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
