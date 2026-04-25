/**
 * Generate a BCF 2.1 zip with one viewpoint per requested door.
 * Each topic contains a camera, clipping planes for the view box, and a tiny
 * compatibility snapshot so BCF viewers can activate the viewpoint.
 *
 * Run from the project root:
 *   npm run generate:door-bcf
 *
 * Defaults:
 *   - IFC path: ARCHH_IFC_PATH or ARCH_IFC_PATH from .env
 *   - GUID filter: scripts/guid.json
 *   - Output: test-output/door-bcf/door-viewpoints.bcfzip
 *
 * Optional overrides:
 *   node scripts/generate-door-bcf-runner.js -- --ifc path/to/model.ifc --guid-file scripts/guid.json --out out/doors.bcfzip
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import 'dotenv/config'
import * as THREE from 'three'
import { IFCDOOR } from 'web-ifc'
import {
    buildBCFZip,
    createDoorBCFTopic,
    expandBoundingBox,
    fitCameraToBoundingBox,
    getPreferredDoorViewDirection,
    getWorldBoundingBoxForElement,
    type DoorBCFTopic,
} from '../lib/bcf-door-viewpoints'
import type { ElementInfo, LoadedIFCModel } from '../lib/ifc-types'
import { closeIFCModel, extractDoorCsetStandardCH, loadIFCModelWithMetadata } from '../lib/ifc-loader'

const DEFAULT_IFC_PATH = resolveEnvPath(process.env.ARCHH_IFC_PATH ?? process.env.ARCH_IFC_PATH)
const DEFAULT_GUID_FILE = resolve(process.cwd(), 'scripts', 'guid.json')
const DEFAULT_OUTPUT_PATH = resolve(process.cwd(), 'test-output', 'door-bcf', 'door-viewpoints.bcfzip')

type GenerateOptions = {
    ifcPath: string | null
    guidFile: string
    outputPath: string
    fieldOfView: number
    aspect: number
    expansionFactor: number
}

type GenerationStats = {
    requestedGuids: number
    generatedTopics: number
    skippedMissingGuid: number
    skippedMissingGeometry: number
    skippedMissingDoorNumber: number
    skippedNotRequested: number
}

function parseArgs(argv: string[]): GenerateOptions {
    if (argv[0] === '--') argv = argv.slice(1)

    const options: GenerateOptions = {
        ifcPath: DEFAULT_IFC_PATH,
        guidFile: DEFAULT_GUID_FILE,
        outputPath: DEFAULT_OUTPUT_PATH,
        fieldOfView: 45,
        aspect: 16 / 9,
        expansionFactor: 0.75,
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const next = argv[i + 1]

        if (arg === '--help' || arg === '-h') {
            printHelp()
            process.exit(0)
        } else if (arg === '--ifc' && next) {
            options.ifcPath = resolve(next)
            i++
        } else if (arg === '--guid-file' && next) {
            options.guidFile = resolve(next)
            i++
        } else if (arg === '--out' && next) {
            options.outputPath = resolve(next)
            i++
        } else if (arg === '--fov' && next) {
            options.fieldOfView = parsePositiveNumber(next, '--fov')
            i++
        } else if (arg === '--aspect' && next) {
            options.aspect = parsePositiveNumber(next, '--aspect')
            i++
        } else if (arg === '--expansion' && next) {
            options.expansionFactor = parsePositiveNumber(next, '--expansion')
            i++
        } else {
            throw new Error(`Unknown or incomplete argument: ${arg}`)
        }
    }

    return options
}

function printHelp(): void {
    console.log(`Generate BCF 2.1 door viewpoints

Usage:
  node scripts/generate-door-bcf-runner.js
  node scripts/generate-door-bcf-runner.js -- --ifc path/to/model.ifc --guid-file scripts/guid.json --out out/doors.bcfzip

Defaults:
  --ifc        ${DEFAULT_IFC_PATH ?? '(set ARCHH_IFC_PATH or ARCH_IFC_PATH in .env, or pass --ifc)'}
  --guid-file  ${DEFAULT_GUID_FILE}
  --out        ${DEFAULT_OUTPUT_PATH}

Notes:
  - --ifc defaults to ARCHH_IFC_PATH or ARCH_IFC_PATH from .env.
  - A tiny compatibility snapshot.png is written because some BCF viewers require it.
  - All elements remain visible in BCF: DefaultVisibility=true.
  - Door topics are named Cset_StandardCH.alTuernummer_GUID.
`)
}

function resolveEnvPath(value: string | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? resolve(trimmed) : null
}

function loadIfcFile(filePath: string): File {
    const buffer = readFileSync(filePath)
    return new File([buffer], basename(filePath), { type: 'application/octet-stream' })
}

function loadRequestedGuids(filePath: string): Set<string> {
    const text = readFileSync(filePath, 'utf8')
    const guids = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))

    return new Set(guids)
}

function getIfcGuid(model: LoadedIFCModel, expressID: number, element?: ElementInfo): string | null {
    if (element?.globalId) return element.globalId.trim()

    const line = model.api.GetLine(model.modelID, expressID)
    const raw = line?.GlobalId?.value ?? line?.GlobalId
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function getDoorNumber(
    csetByExpressId: Map<number, { alTuernummer: string | null }>,
    expressID: number
): string | null {
    const value = csetByExpressId.get(expressID)?.alTuernummer
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function generateTopicsForRequestedDoors(
    model: LoadedIFCModel,
    csetByExpressId: Map<number, { alTuernummer: string | null }>,
    requestedGuids: Set<string>,
    options: GenerateOptions
): { topics: DoorBCFTopic[]; stats: GenerationStats; missingRequestedGuids: string[] } {
    const elementsByExpressID = new Map(model.elements.map((element) => [element.expressID, element]))
    const doorIds = model.api.GetLineIDsWithType(model.modelID, IFCDOOR)
    const topics: DoorBCFTopic[] = []
    const seenRequestedGuids = new Set<string>()
    const stats: GenerationStats = {
        requestedGuids: requestedGuids.size,
        generatedTopics: 0,
        skippedMissingGuid: 0,
        skippedMissingGeometry: 0,
        skippedMissingDoorNumber: 0,
        skippedNotRequested: 0,
    }

    for (let i = 0; i < doorIds.size(); i++) {
        const expressID = doorIds.get(i)
        const element = elementsByExpressID.get(expressID)
        const ifcGuid = getIfcGuid(model, expressID, element)

        if (!ifcGuid) {
            stats.skippedMissingGuid++
            continue
        }

        if (!requestedGuids.has(ifcGuid)) {
            stats.skippedNotRequested++
            continue
        }

        seenRequestedGuids.add(ifcGuid)

        if (!element) {
            stats.skippedMissingGeometry++
            continue
        }

        const doorNumber = getDoorNumber(csetByExpressId, expressID)
        if (!doorNumber) {
            stats.skippedMissingDoorNumber++
            console.warn(`Skipping ${ifcGuid}: missing Cset_StandardCH.alTuernummer`)
            continue
        }

        const rawBox = getWorldBoundingBoxForElement(element)
        if (!rawBox || rawBox.isEmpty()) {
            stats.skippedMissingGeometry++
            console.warn(`Skipping ${ifcGuid}: missing door geometry/bounding box`)
            continue
        }

        const viewBox = expandBoundingBox(rawBox, options.expansionFactor)
        const camera = new THREE.PerspectiveCamera(options.fieldOfView, options.aspect, 0.01, 10000)
        const fit = fitCameraToBoundingBox(camera, viewBox, getPreferredDoorViewDirection(element))

        topics.push(createDoorBCFTopic({
            door: element,
            ifcGuid,
            doorNumber,
            camera: fit.camera,
            viewBox: fit.viewBox,
            target: fit.target,
        }))
        stats.generatedTopics++
    }

    const missingRequestedGuids = [...requestedGuids]
        .filter((guid) => !seenRequestedGuids.has(guid))
        .sort()

    return { topics, stats, missingRequestedGuids }
}

function parsePositiveNumber(raw: string, label: string): number {
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be a positive number, got ${raw}`)
    }
    return value
}

function ensureReadableFile(filePath: string, label: string): void {
    if (!existsSync(filePath)) {
        throw new Error(`${label} does not exist: ${filePath}`)
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))

    if (!options.ifcPath) {
        throw new Error('No IFC file configured. Set ARCHH_IFC_PATH or ARCH_IFC_PATH in .env, or pass --ifc.')
    }

    ensureReadableFile(options.ifcPath, 'IFC file')
    ensureReadableFile(options.guidFile, 'GUID file')

    console.log(`Loading GUID filter: ${options.guidFile}`)
    const requestedGuids = loadRequestedGuids(options.guidFile)
    if (requestedGuids.size === 0) {
        throw new Error(`GUID file contains no GUIDs: ${options.guidFile}`)
    }

    console.log(`Loading IFC: ${options.ifcPath}`)
    const ifcFile = loadIfcFile(options.ifcPath)
    const model = await loadIFCModelWithMetadata(ifcFile)

    try {
        console.log('Extracting Cset_StandardCH door numbers...')
        const csetByExpressId = await extractDoorCsetStandardCH(ifcFile)

        console.log('Generating BCF viewpoints...')
        const { topics, stats, missingRequestedGuids } = generateTopicsForRequestedDoors(
            model,
            csetByExpressId,
            requestedGuids,
            options
        )

        if (topics.length === 0) {
            throw new Error('No BCF topics were generated. Check GUIDs, door geometry, and Cset_StandardCH.alTuernummer values.')
        }

        const zipBytes = await buildBCFZip(topics, {
            projectName: basename(options.ifcPath),
            ifcFileName: basename(options.ifcPath),
        })

        mkdirSync(dirname(options.outputPath), { recursive: true })
        writeFileSync(options.outputPath, zipBytes)

        console.log(`Wrote ${topics.length} BCF topics to ${options.outputPath}`)
        console.log(`Requested GUIDs: ${stats.requestedGuids}`)
        console.log(`Generated topics: ${stats.generatedTopics}`)
        console.log(`Skipped not in GUID file: ${stats.skippedNotRequested}`)
        console.log(`Skipped missing GUID: ${stats.skippedMissingGuid}`)
        console.log(`Skipped missing geometry: ${stats.skippedMissingGeometry}`)
        console.log(`Skipped missing Cset_StandardCH.alTuernummer: ${stats.skippedMissingDoorNumber}`)

        if (missingRequestedGuids.length > 0) {
            console.warn(`Requested GUIDs not found as IfcDoor in this IFC: ${missingRequestedGuids.length}`)
            console.warn(missingRequestedGuids.slice(0, 20).join('\n'))
            if (missingRequestedGuids.length > 20) {
                console.warn(`...and ${missingRequestedGuids.length - 20} more`)
            }
        }
    } finally {
        closeIFCModel(model.modelID)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
