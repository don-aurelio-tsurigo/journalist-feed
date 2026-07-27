# Tsüri Newsfeed – Grundgerüst

Ad-hoc Feed lokaler Zürich-Quellen (RSS) mit Review-UI für die Redaktion.
Läuft komplett auf Cloudflare (Worker + D1), Frontend wird als Static Asset
mitausgeliefert. 

## Setup

1. **Abhängigkeiten installieren**
   ```
   npm install
   ```

2. **D1-Datenbank anlegen**
   ```
   npx wrangler d1 create tsri-news-feed-db
   ```
   Die zurückgegebene `database_id` in `wrangler.toml` eintragen
   (ersetzt `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

3. **Schema anlegen**
   ```
   npm run db:init:remote
   ```
   (für lokale Entwicklung zusätzlich `npm run db:init:local`)

4. **Lokal testen**
   ```
   npm run dev
   ```
   Dashboard läuft dann auf `http://localhost:8787`.
   Über den Button "Jetzt aktualisieren" (oder `POST /api/run`) einen
   manuellen Fetch-Zyklus auslösen, um Testdaten reinzuziehen.

5. **Deployen**
   ```
   npm run deploy
   ```
   Danach läuft der Cron-Trigger automatisch alle 15 Minuten
   (siehe `[triggers]` in `wrangler.toml`).

6. **Zugriff einschränken (Cloudflare Access)**
   Im Zero-Trust-Dashboard eine Access-Application auf die Worker-Domain/Route
   legen und die E-Mail-Adressen der Redaktion (bzw. eine Domain-Regel für
   @tsri.ch) freigeben. Das ist bewusst nicht Teil dieses Repos, da Access
   meist zentral über das Cloudflare-Dashboard verwaltet wird.

## Offene Punkte / nächste Schritte

- **Stadtpolizei-RSS-URL verifizieren.** In `src/index.ts` ist die URL nach
  dem gleichen Muster wie die Medienmitteilungen abgeleitet, aber nicht
  bestätigt. Einmal auf
  `stadt-zuerich.ch/de/politik-und-verwaltung/stadtverwaltung/sid/stapo.html`
  den "RSS-Feed abonnieren"-Link prüfen und ggf. korrigieren.
- **Baugesuche Kanton Zürich** sind bewusst noch nicht eingebaut. Die Daten
  gibt es als Geopackage (GPKG) über opendata.swiss ("Baugesuche im Kanton
  Zürich"), das ist kein einfaches RSS/CSV und bräuchte einen eigenen
  Parsing-Schritt (z.B. GDAL/ogr2ogr zu GeoJSON, dann als dritte Quelle
  einbauen).
- **Kategorisierung/Scoring:** aktuell landet alles undifferenziert im
  "Neu"-Tab. Eine Anreicherung via Claude API (Kategorie, Kurz-Zusammenfassung,
  Relevanz-Score nach Quartier/Thema) liesse sich als zusätzlicher Schritt im
  `runFetchCycle` einbauen, bevor die Items in D1 landen.
- **Keyword-Alerts:** noch nicht gebaut. Ansatzpunkt wäre eine zweite Tabelle
  mit abonnierten Keywords pro Person + ein Vergleich beim Upsert, der bei
  Treffer z.B. eine Slack-Nachricht schickt (Slack-Connector ist ja
  vorhanden).

## Struktur

```
wrangler.toml     Worker-Konfiguration (D1-Binding, Cron, Assets)
schema.sql        D1-Schema für news_items
src/index.ts      Worker: Cron-Fetch + REST-API
public/index.html Frontend-Dashboard (Vanilla JS, keine Build-Step nötig)
```
