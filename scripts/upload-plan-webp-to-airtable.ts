/**
 * Lädt lokale `*_plan.webp` in Airtable in das Anhang-Feld `AR01_FloorAnsicht`,
 * passend zur GUID-Spalte (Default: `AL00_GUID`).
 *
 * Voraussetzung: öffentlich erreichbare URL (hier: @vercel/blob via BLOB_READ_WRITE_TOKEN).
 *
 * **GUID-Quellen** (analog `scripts/test-plan-door-visibility.ts`):
 * - Wenn `USER_PLAN_WEBP_AIRTABLE_CONFIG.doorGuids` und optional `doorGuidsFile` gesetzt sind,
 *   werden beide **gemergt** (zuerst Array, dann Datei, ohne Duplikate).
 * - `doorGuids: []` + nur Datei → nur GUIDs aus der Datei.
 * - `doorGuids: ['…']` + `doorGuidsFile: null` → nur die Inline-Liste.
 * - **Beide leer** (und kein „Override“ unten) → **alle** `*_plan.webp` im Bildordner.
 * - **Overrides** ersetzen die obige Konfiguration für genau diesen Lauf (wie `--door-guid` / Env beim Plan-Test):
 *   1) `npm run upload:plan-webp-airtable -- --door-guid=GUID` bzw. `--door-guid a,b` (führendes `--` bei npm nötig)
 *   2) `PLAN_DOOR_GUID` / `DOOR_GUID` in der Umgebung (komma- oder strichpunktgetrennt)
 *   3) `--guid-json=pfad` (JSON oder Text, siehe `loadGuidsFromFile`)
 *   4) `--guids=a,b` (Kurzform)
 *   5) `USER_…` Merge (`doorGuids` + `doorGuidsFile`)
 *   6) sonst alle Dateien im Ordner
 *
 * `doorGuidsFile`: eine GlobalId pro Zeile **und/oder** durch Leerzeichen, Komma, Semikolon;
 *   alternativ `["…"]` / `{ "guids": ["…"] }` (JSON).
 *
 * Usage:
 *   npm run upload:plan-webp-airtable
 *   npm run upload:plan-webp-airtable -- --door-guid=0HQZhZFdqXIwjzDgrVSwj5
 *   npm run upload:plan-webp-airtable -- --guid-json=./guid.json
 *   npm run upload:plan-webp-airtable -- --image-dir=./test-output/plan-door-visibility --dry-run
 *
 * Env: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME, BLOB_READ_WRITE_TOKEN
 *      optional: AIRTABLE_GUID_FIELD, AIRTABLE_PLAN_FIELD, PLAN_DOOR_GUID / DOOR_GUID
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { put } from '@vercel/blob'

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0'
const MAX_RATE_LIMIT_RETRIES = 5
const SLEEP_BETWEEN_RECORDS_MS = 250

// ---------------------------------------------------------------------------
// Pfade + GUID-Liste: wie in test-plan-door-visibility (merge doorGuids + doorGuidsFile).
// Eine `doorGuidsFile`-Zeile: aktiv lassen, die andere ggf. auskommentieren (oder beide befüllen = Merge).
// ---------------------------------------------------------------------------
const USER_PLAN_WEBP_AIRTABLE_CONFIG = {
  doorGuids: ['0HQZhZFdqXIwjzDgrVSwj5','2wlA$J1j_AGvOU8swNH3xo','1vxXWElwljJPBHOg5wmNvz'] as string[],

  /** `null` = keine Datei; z. B. `resolve(process.cwd(), 'scripts', 'guid.json')` */
  doorGuidsFile: null as string | null,
  // doorGuidsFile: resolve(process.cwd(), 'scripts', 'guid.json'),
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function getBackoffMs(attempt: number): number {
  const base = 700 * 2 ** attempt
  return Math.min(base + Math.floor(Math.random() * 300), 10_000)
}

function resolveConfigPath(p: string | null): string | null {
  if (p == null || p.trim() === '') return null
  return resolve(p)
}

function parseGuidTokensFromFileText(text: string): string[] {
  return text
    .split(/[\r\n,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Wie test-plan-Datei: flacher Text, oder JSON `["…"]` / `{ "guids": ["…"] }` */
function loadGuidsFromFile(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(text) as unknown
      if (Array.isArray(data)) return data.map((x) => String(x).trim()).filter(Boolean)
      if (data && typeof data === 'object' && 'guids' in data) {
        const g = (data as { guids?: unknown }).guids
        if (Array.isArray(g)) return g.map((x) => String(x).trim()).filter(Boolean)
      }
    } catch {
      /* kein brauchbares JSON → unten tokenisieren */
    }
  }
  return parseGuidTokensFromFileText(text)
}

/** Merge wie `test-plan` — Reihenfolge: zuerst Array, dann Datei; Dedupe. */
function resolveDoorGuidList(
  doorGuids: string[] | undefined,
  doorGuidsFile: string | null | undefined
): string[] {
  const fromArray = (doorGuids ?? []).map((g) => g.trim()).filter(Boolean)
  const filePath = resolveConfigPath(doorGuidsFile ?? null)
  let fromFile: string[] = []
  if (filePath && existsSync(filePath)) {
    try {
      const st = statSync(filePath)
      if (st.size === 0) {
        console.warn(
          `[plan-webp-airtable] doorGuidsFile ist 0 Bytes — prüfen: ${filePath}`
        )
      }
    } catch {
      /* */
    }
    fromFile = loadGuidsFromFile(filePath)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of [...fromArray, ...fromFile]) {
    if (seen.has(g)) continue
    seen.add(g)
    out.push(g)
  }
  const filePathForLog = resolveConfigPath(doorGuidsFile ?? null)
  if (doorGuidsFile != null && String(doorGuidsFile).trim() !== '') {
    if (!filePathForLog || !existsSync(filePathForLog)) {
      console.warn(
        `[plan-webp-airtable] doorGuidsFile fehlt oder unlesbar: ${filePathForLog ?? String(doorGuidsFile)}`
      )
    } else if (fromFile.length === 0) {
      console.warn(
        `[plan-webp-airtable] doorGuidsFile ohne nutzbare GUID-Zeilen: ${filePathForLog}`
      )
    }
  }
  return out
}

/** Ersetzt Konfig+Merge, wenn non-null (dasselbe Muster wie plan-door-Test). */
function parseCliDoorGuidOverrides(argv: string[]): string[] | null {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a?.startsWith('--door-guid=')) {
      out.push(
        ...a
          .slice('--door-guid='.length)
          .split(/[,;]/g)
          .map((s) => s.trim())
          .filter(Boolean)
      )
      continue
    }
    if (a === '--door-guid' && i + 1 < argv.length) {
      out.push(
        ...String(argv[i + 1])
          .split(/[,;]/g)
          .map((s) => s.trim())
          .filter(Boolean)
      )
      i++
    }
  }
  return out.length > 0 ? out : null
}

function parseEnvDoorGuidOverrides(): string[] | null {
  const raw = process.env.PLAN_DOOR_GUID?.trim() || process.env.DOOR_GUID?.trim()
  if (!raw) return null
  const ids = raw.split(/[,;]/g).map((s) => s.trim()).filter(Boolean)
  return ids.length > 0 ? ids : null
}

async function airtableFetch(input: string, init: RequestInit, token: string, operation: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const h = new Headers(init.headers)
    h.set('Authorization', `Bearer ${token}`)
    if (init.body && !h.has('content-type')) h.set('Content-Type', 'application/json')
    const response = await fetch(input, { ...init, headers: h })
    if (response.ok) return response
    const body = await response.clone().text()
    if (response.status === 429 || body.includes('RATE_LIMIT_REACHED')) {
      if (attempt === MAX_RATE_LIMIT_RETRIES) return response
      const wait = getBackoffMs(attempt)
      console.warn(`[Airtable] ${operation} rate-limited, retry in ${wait}ms`)
      await sleep(wait)
      continue
    }
    return response
  }
  throw new Error('Unexpected Airtable retry state')
}

function safeFormulaString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')
}

function sanitizeBlobSegment(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return t.slice(0, 255) || 'unknown'
}

type CliOptions = {
  imageDir: string
  guidJson: string | null
  guidsList: string[] | null
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  let imageDir = resolve(process.cwd(), 'test-output', 'plan-door-visibility')
  let guidJson: string | null = null
  let guidsList: string[] | null = null
  let dryRun = false
  let help = false

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') help = true
    else if (arg.startsWith('--image-dir=')) imageDir = resolve(arg.slice('--image-dir='.length))
    else if (arg.startsWith('--guid-json=')) guidJson = resolve(arg.slice('--guid-json='.length))
    else if (arg.startsWith('--guids=')) {
      const raw = arg.slice('--guids='.length)
      guidsList = raw
        .split(/[;,]/)
        .map((g) => g.trim())
        .filter(Boolean)
    } else if (arg === '--dry-run') dryRun = true
  }
  return { imageDir, guidJson, guidsList, dryRun, help }
}

const PLAN_RE = /^(.+?)_plan\.webp$/i

function listPlanWebpByGuid(imageDir: string): Map<string, string> {
  if (!existsSync(imageDir) || !statSync(imageDir).isDirectory()) {
    throw new Error(`Bildordner fehlt oder kein Verzeichnis: ${imageDir}`)
  }
  const out = new Map<string, string>()
  for (const name of readdirSync(imageDir)) {
    if (extname(name).toLowerCase() !== '.webp') continue
    const m = name.match(PLAN_RE)
    if (!m) continue
    out.set(m[1], resolve(imageDir, name))
  }
  return out
}

function resolveTargetGuids(
  argv: string[],
  onDisk: Map<string, string>,
  opts: CliOptions
): { guids: string[]; source: string } {
  const cli = parseCliDoorGuidOverrides(argv)
  if (cli) {
    return { guids: cli, source: 'CLI --door-guid' }
  }
  const fromEnv = parseEnvDoorGuidOverrides()
  if (fromEnv) {
    return { guids: fromEnv, source: 'PLAN_DOOR_GUID / DOOR_GUID' }
  }
  if (opts.guidJson) {
    if (!existsSync(opts.guidJson)) {
      throw new Error(`--guid-json Datei nicht gefunden: ${opts.guidJson}`)
    }
    return { guids: loadGuidsFromFile(opts.guidJson), source: `CLI --guid-json (${opts.guidJson})` }
  }
  if (opts.guidsList && opts.guidsList.length > 0) {
    return { guids: [...opts.guidsList], source: 'CLI --guids' }
  }

  const merged = resolveDoorGuidList(
    USER_PLAN_WEBP_AIRTABLE_CONFIG.doorGuids,
    USER_PLAN_WEBP_AIRTABLE_CONFIG.doorGuidsFile
  )
  if (merged.length > 0) {
    return {
      guids: merged,
      source: 'USER_PLAN_WEBP_AIRTABLE_CONFIG (doorGuids + ggf. doorGuidsFile)',
    }
  }
  return { guids: [...onDisk.keys()], source: 'alle *_plan.webp im Ordner' }
}

async function findFirstRecordId(
  baseId: string,
  table: string,
  guidField: string,
  guid: string,
  token: string
): Promise<string | null> {
  const safe = safeFormulaString(guid)
  const tableUrl = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(table)}`
  const filterByFormula = `{${guidField}}="${safe}"`
  const searchUrl = `${tableUrl}?filterByFormula=${encodeURIComponent(filterByFormula)}`
  const res = await airtableFetch(searchUrl, { method: 'GET' }, token, 'list records (by guid)')
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Airtable Suche fehlgeschlagen: ${res.status} ${t}`)
  }
  const data = (await res.json()) as { records?: { id: string }[] }
  if (!data.records || data.records.length === 0) return null
  if (data.records.length > 1) {
    console.warn(`[warn] ${guidField}="${guid}": ${data.records.length} Zeilen, verwende die erste.`)
  }
  return data.records[0].id
}

async function updatePlanAttachment(
  baseId: string,
  table: string,
  recordId: string,
  planField: string,
  publicUrl: string,
  token: string
): Promise<void> {
  const url = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(table)}/${recordId}`
  const res = await airtableFetch(
    url,
    {
      method: 'PATCH',
      body: JSON.stringify({ fields: { [planField]: [{ url: publicUrl }] } }),
    },
    token,
    'update record'
  )
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Airtable Update: ${res.status} ${t}`)
  }
}

function printHelp(): void {
  console.log(`upload-plan-webp-to-airtable

Bilder:  <image-dir> / <GUID>_plan.webp

GUID-Quelle (siehe Kopfkommentar) — wichtigste: wie test-plan, Objekt
USER_PLAN_WEBP_AIRTABLE_CONFIG, optional Merge mit doorGuidsFile, oder:
  --door-guid=…  /  --door-guid  a,b
  Umgebung: PLAN_DOOR_GUID oder DOOR_GUID
  --guid-json=   (JSON-Array, { "guids": […] } oder roher Text)
  --guids=a,b
  (ohne obiges: alle WebPs im Verzeichnis, wenn weder Array noch Datei-Guids in USER_…)
Weitere:
  --image-dir=   Standard: test-output/plan-door-visibility
  --dry-run      kein Upload / kein Airtable-Update
  --help
`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return
  }

  const token = process.env.AIRTABLE_TOKEN
  const baseId = process.env.AIRTABLE_BASE_ID
  const table = process.env.AIRTABLE_TABLE_NAME || 'Doors'
  const guidField = process.env.AIRTABLE_GUID_FIELD || 'AL00_GUID'
  const planField = process.env.AIRTABLE_PLAN_FIELD || 'AR01_FloorAnsicht'
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN

  if (!token || !baseId) {
    console.error('Fehlend: AIRTABLE_TOKEN und/oder AIRTABLE_BASE_ID in der Umgebung (z. B. .env).')
    process.exit(1)
  }
  if (!opts.dryRun && !blobToken) {
    console.error('Fehlend: BLOB_READ_WRITE_TOKEN (für @vercel/blob) oder --dry-run verwenden.')
    process.exit(1)
  }

  const onDisk = listPlanWebpByGuid(opts.imageDir)
  const { guids, source } = resolveTargetGuids(argv, onDisk, opts)
  if (
    source === 'CLI --door-guid' ||
    source.startsWith('PLAN_DOOR_GUID') ||
    source.startsWith('CLI --guid-json') ||
    source === 'CLI --guids'
  ) {
    console.log(`[plan-webp-airtable] ${source} (${guids.length}): ${guids.join(', ')}`)
  }
  console.log(`Bildordner: ${opts.imageDir}`)
  console.log(`Quelle der GUID-Liste: ${source}`)
  console.log(`${guids.length} GUID(s) zu verarbeiten\n`)

  if (onDisk.size === 0) {
    console.warn('Keine passenden *_plan.webp Dateien im Ordner.')
  }

  let ok = 0
  let skip = 0
  for (const guid of guids) {
    const filePath = onDisk.get(guid)
    if (!filePath) {
      console.warn(`[übersprungen] kein *${guid}_plan.webp in ${opts.imageDir}`)
      skip += 1
      continue
    }

    if (opts.dryRun) {
      console.log(`[dry-run] ${guid} → würde ${filePath} → ${planField} setzen`)
      ok += 1
      continue
    }

    const recordId = await findFirstRecordId(baseId, table, guidField, guid, token)
    if (!recordId) {
      console.warn(`[übersprungen] Airtable: kein Record mit {${guidField}} = ${guid}`)
      skip += 1
      continue
    }

    const buffer = readFileSync(filePath)
    const pathSeg = `plan-webp/${sanitizeBlobSegment(guid)}_${Date.now()}.webp`
    const uploaded = await put(pathSeg, buffer, {
      access: 'public',
      contentType: 'image/webp',
      token: blobToken!,
    })

    await updatePlanAttachment(baseId, table, recordId, planField, uploaded.url, token)
    console.log(`[ok] ${guid} → ${planField} (${uploaded.url})`)
    ok += 1
    if (SLEEP_BETWEEN_RECORDS_MS > 0) await sleep(SLEEP_BETWEEN_RECORDS_MS)
  }

  console.log(`\nFertig. Erfolg: ${ok}, übersprungen/fehlt: ${skip}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
