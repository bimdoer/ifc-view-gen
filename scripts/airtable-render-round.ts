/**
 * Airtable render round.
 *
 * Pull every Doors row where Valid != yes (or a subset via --guids/--guid-file),
 * render front/back/plan from the IFC pair in .env, rasterise to PNG @ 1400 w,
 * keep a local backup, and overwrite the Plan/Front/Back attachments on each
 * Airtable record. Idempotent — re-running the same non-yes queue is safe.
 *
 * Flags:
 *   --guids=a,b,c        subset
 *   --guid-file=path     subset from file (one per line, or comma/space/semicolon)
 *   --force              include Valid=yes too (for regression reruns)
 *   --dry-run            print the plan, render nothing
 *   --local-only         render + rasterise + local backup, skip Airtable
 *   --only=front,plan    limit views (default: front,back,plan)
 *   --limit=N            smoke test — only render the first N targets
 *
 * Env:
 *   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
 *   ARCH_IFC_PATH, ELEC_IFC_PATH
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderDoorsFromIfc, type DoorView } from '../lib/door-render-pipeline'
import { rasterizeSvgToPng, DEFAULT_RASTER_WIDTH_PX } from '../lib/png-rasterize'
import {
    clearAttachments,
    listDoors,
    uploadAttachment,
    type AirtableConfig,
    type DoorRecord,
} from '../lib/airtable-client'

const ALL_VIEWS: readonly DoorView[] = ['front', 'back', 'plan']

const VIEW_TO_FIELD: Record<DoorView, 'Plan' | 'Front' | 'Back'> = {
    plan: 'Plan',
    front: 'Front',
    back: 'Back',
}

const LOCK_FILE = resolve(process.cwd(), '.airtable-round.lock')
const LOCK_TTL_MS = 60 * 60 * 1000
const MAX_ATTACHMENT_BYTES = 4.5 * 1024 * 1024

interface CliFlags {
    guids: string[] | null
    guidFile: string | null
    force: boolean
    dryRun: boolean
    localOnly: boolean
    views: readonly DoorView[]
    limit: number | null
}

function parseCsvGuids(raw: string): string[] {
    return raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

function parseFlags(argv: string[]): CliFlags {
    const flags: CliFlags = {
        guids: null,
        guidFile: null,
        force: false,
        dryRun: false,
        localOnly: false,
        views: ALL_VIEWS,
        limit: null,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--') {
            // Bare `--` is npm's end-of-options marker and leaks through `node` invocation.
            continue
        } else if (arg === '--help' || arg === '-h') {
            printHelp()
            process.exit(0)
        } else if (arg === '--force') {
            flags.force = true
        } else if (arg === '--dry-run') {
            flags.dryRun = true
        } else if (arg === '--local-only') {
            flags.localOnly = true
        } else if (arg.startsWith('--guids=')) {
            flags.guids = parseCsvGuids(arg.slice('--guids='.length))
        } else if (arg === '--guids' && i + 1 < argv.length) {
            flags.guids = parseCsvGuids(argv[++i])
        } else if (arg.startsWith('--guid-file=')) {
            flags.guidFile = arg.slice('--guid-file='.length)
        } else if (arg === '--guid-file' && i + 1 < argv.length) {
            flags.guidFile = argv[++i]
        } else if (arg.startsWith('--only=')) {
            const views = arg.slice('--only='.length).split(',').map((v) => v.trim().toLowerCase())
            flags.views = views.filter((v): v is DoorView => v === 'front' || v === 'back' || v === 'plan')
            if (flags.views.length === 0) {
                throw new Error(`--only must list at least one of front,back,plan — got "${arg}"`)
            }
        } else if (arg.startsWith('--limit=')) {
            const n = Number.parseInt(arg.slice('--limit='.length), 10)
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive integer`)
            flags.limit = n
        } else {
            throw new Error(`Unknown flag: ${arg}`)
        }
    }
    return flags
}

function printHelp(): void {
    console.log(`airtable-render-round — render Doors table images

Flags:
  --guids=a,b,c        subset (comma/space/semicolon separated)
  --guid-file=path     subset from file (same separators, newlines ok)
  --force              include Valid=yes (re-render everything)
  --dry-run            list targets and exit
  --local-only         render locally; skip Airtable writes
  --only=front,plan    subset of views (default all three)
  --limit=N            only render first N targets

Env:
  AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
  ARCH_IFC_PATH, ELEC_IFC_PATH`)
}

function readGuidsFromFile(path: string): string[] {
    const abs = resolve(path)
    if (!existsSync(abs)) throw new Error(`--guid-file not found: ${abs}`)
    return parseCsvGuids(readFileSync(abs, 'utf8'))
}

function requireEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required in environment (.env)`)
    return value
}

function acquireLock(): void {
    if (existsSync(LOCK_FILE)) {
        const age = Date.now() - statSync(LOCK_FILE).mtimeMs
        if (age < LOCK_TTL_MS) {
            throw new Error(
                `Round already in progress (${LOCK_FILE}, ${Math.round(age / 1000)}s old). `
                    + `Delete the file manually if you are sure nothing else is running.`
            )
        }
        console.warn(`Stale lock (${Math.round(age / 1000)}s); stealing.`)
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

function releaseLock(): void {
    try {
        if (existsSync(LOCK_FILE)) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('node:fs').unlinkSync(LOCK_FILE)
        }
    } catch {
        /* best-effort */
    }
}

function roundId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-')
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2))

    const airtable: AirtableConfig = {
        token: requireEnv('AIRTABLE_TOKEN'),
        baseId: requireEnv('AIRTABLE_BASE_ID'),
        tableName: process.env.AIRTABLE_TABLE_NAME || 'Doors',
    }
    const archIfc = resolve(requireEnv('ARCH_IFC_PATH'))
    const elecIfc = process.env.ELEC_IFC_PATH ? resolve(process.env.ELEC_IFC_PATH) : null
    if (!existsSync(archIfc)) throw new Error(`ARCH_IFC_PATH not found: ${archIfc}`)
    if (elecIfc && !existsSync(elecIfc)) throw new Error(`ELEC_IFC_PATH not found: ${elecIfc}`)

    acquireLock()
    try {
        const backupRoot = resolve(process.cwd(), 'test-output', 'airtable-rounds', roundId())
        mkdirSync(backupRoot, { recursive: true })
        console.log(`Round backup dir: ${backupRoot}`)

        // 1. Fetch candidates
        console.log(`\nFetching Airtable records (onlyNonValid=${!flags.force})...`)
        const allDoors = await listDoors(airtable, { onlyNonValid: !flags.force })
        const airtableByGuid = new Map(allDoors.map((d) => [d.guid, d]))
        console.log(`  ${allDoors.length} record(s) in queue`)

        // 2. Intersect with subset
        const subsetGuids = new Set<string>()
        if (flags.guids) flags.guids.forEach((g) => subsetGuids.add(g))
        if (flags.guidFile) readGuidsFromFile(flags.guidFile).forEach((g) => subsetGuids.add(g))

        let targets: DoorRecord[]
        if (subsetGuids.size > 0) {
            const missingInAirtable: string[] = []
            targets = []
            for (const guid of subsetGuids) {
                const record = airtableByGuid.get(guid)
                if (record) targets.push(record)
                else missingInAirtable.push(guid)
            }
            if (missingInAirtable.length > 0) {
                throw new Error(
                    `Subset has ${missingInAirtable.length} GUID(s) not in Airtable: ${missingInAirtable.slice(0, 5).join(', ')}${
                        missingInAirtable.length > 5 ? ', …' : ''
                    }`
                )
            }
        } else {
            targets = allDoors
        }

        if (flags.limit !== null && targets.length > flags.limit) {
            targets = targets.slice(0, flags.limit)
        }

        if (targets.length === 0) {
            console.log('Nothing to render — all caught up.')
            return
        }

        console.log(`\nTargets: ${targets.length} GUID(s)`)
        if (flags.dryRun) {
            for (const t of targets) console.log(`  - ${t.guid}`)
            console.log('\n--dry-run: exiting without rendering.')
            return
        }

        // 3. Render everything in one IFC session
        console.log(`\nLoading IFC and rendering (views: ${flags.views.join(',')})...`)
        const targetGuids = targets.map((t) => t.guid)
        const result = await renderDoorsFromIfc(
            { archIfcPath: archIfc, elecIfcPath: elecIfc },
            targetGuids,
            flags.views
        )
        console.log(
            `  rendered=${result.rendered.size} renderErrors=${result.renderErrors.size} notInIfc=${result.notInIfc.length}`
        )

        // 4. Per-GUID: local backup + Airtable writes
        const ok: string[] = []
        const failed: Array<{ guid: string; reason: string }> = []

        for (const target of targets) {
            const guid = target.guid
            const guidDir = resolve(backupRoot, sanitize(guid))
            mkdirSync(guidDir, { recursive: true })

            const renderError = result.renderErrors.get(guid)
            const rendered = result.rendered.get(guid)

            if (result.notInIfc.includes(guid)) {
                writeFileSync(resolve(guidDir, 'status.txt'), 'NOT_IN_IFC\n')
                failed.push({ guid, reason: 'not in IFC' })
                continue
            }

            if (renderError || !rendered) {
                const msg = renderError?.stack ?? renderError?.message ?? 'no renderer output'
                writeFileSync(resolve(guidDir, 'error.txt'), `${msg}\n`)
                failed.push({ guid, reason: `render failed: ${renderError?.message ?? 'unknown'}` })
                continue
            }

            // Write SVG + PNG backup for every rendered view before touching Airtable.
            const pngByView: Partial<Record<DoorView, Buffer>> = {}
            let rasterFailed = false
            for (const view of flags.views) {
                const svg = rendered.svg[view]
                if (!svg) continue
                writeFileSync(resolve(guidDir, `${view}.svg`), svg, 'utf8')
                let png: Buffer
                try {
                    png = rasterizeSvgToPng(svg)
                } catch (err) {
                    writeFileSync(
                        resolve(guidDir, `${view}-raster-error.txt`),
                        err instanceof Error ? (err.stack ?? err.message) : String(err)
                    )
                    rasterFailed = true
                    break
                }
                if (png.byteLength > MAX_ATTACHMENT_BYTES) {
                    // Retry smaller once; if still oversized, give up on this view.
                    try {
                        png = rasterizeSvgToPng(svg, 1000)
                    } catch (err) {
                        writeFileSync(
                            resolve(guidDir, `${view}-raster-error.txt`),
                            err instanceof Error ? (err.stack ?? err.message) : String(err)
                        )
                        rasterFailed = true
                        break
                    }
                    if (png.byteLength > MAX_ATTACHMENT_BYTES) {
                        writeFileSync(
                            resolve(guidDir, `${view}-raster-error.txt`),
                            `PNG still > ${MAX_ATTACHMENT_BYTES} bytes after width=1000 retry.`
                        )
                        rasterFailed = true
                        break
                    }
                }
                writeFileSync(resolve(guidDir, `${view}.png`), png)
                pngByView[view] = png
            }
            if (rasterFailed) {
                failed.push({ guid, reason: 'rasterisation failed (see backup dir)' })
                continue
            }

            if (flags.localOnly) {
                ok.push(guid)
                continue
            }

            try {
                const fieldsToClear = flags.views.map((v) => VIEW_TO_FIELD[v])
                await clearAttachments(airtable, target.id, fieldsToClear)
                for (const view of flags.views) {
                    const png = pngByView[view]
                    if (!png) continue
                    await uploadAttachment(airtable, target.id, VIEW_TO_FIELD[view], {
                        filename: `${sanitize(guid)}-${view}.png`,
                        contentType: 'image/png',
                        bytes: png,
                    })
                }
                ok.push(guid)
                process.stdout.write(`\r  uploaded ${ok.length}/${targets.length}`)
            } catch (err) {
                const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
                writeFileSync(resolve(guidDir, 'upload-error.txt'), `${msg}\n`)
                failed.push({ guid, reason: `upload failed: ${err instanceof Error ? err.message : String(err)}` })
            }
        }
        if (ok.length > 0) process.stdout.write('\n')

        // 5. Summary
        console.log(`\n--- summary ---`)
        console.log(`  ok:     ${ok.length}`)
        console.log(`  failed: ${failed.length}`)
        for (const f of failed) console.log(`    - ${f.guid}: ${f.reason}`)
        console.log(`  backup: ${backupRoot}`)

        if (failed.length > 0) process.exitCode = 1
    } finally {
        releaseLock()
    }
}

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'door'
}

main().catch((err) => {
    // Per-GUID errors are already captured to the backup dir; at top level the
    // message is enough. Full stacks are only useful while developing the CLI,
    // in which case set DEBUG_STACK=1.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(process.env.DEBUG_STACK ? (err instanceof Error ? err.stack : err) : msg)
    releaseLock()
    process.exit(1)
})
