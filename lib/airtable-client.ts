/**
 * Thin Airtable wrapper tailored to the door-render round:
 *   - list door rows (with pagination + Valid!=yes filter)
 *   - overwrite attachment fields (clear → upload)
 *   - upload PNG bytes directly via content.airtable.com (no blob host needed)
 *
 * All network calls pass through a single 5 req/s token bucket so pagination,
 * clears, uploads, and patches can be scheduled without coordinating locally.
 */

const API = 'https://api.airtable.com/v0'
const CONTENT = 'https://content.airtable.com/v0'

// Airtable publishes a 5 req/s/base limit. Stay a fraction under to leave room
// for retries without tripping the sliding window.
const TOKEN_CAPACITY = 5
const TOKEN_REFILL_MS = 250

export interface AirtableConfig {
    token: string
    baseId: string
    tableName: string
}

export interface DoorRecord {
    id: string
    guid: string
    valid: 'yes' | 'no' | null
    /** Full field payload, in case callers need Comment/Category/etc. */
    fields: Record<string, unknown>
}

export interface AttachmentFieldBytes {
    filename: string
    contentType: string
    bytes: Buffer
}

class TokenBucket {
    private available = TOKEN_CAPACITY
    private waiters: Array<() => void> = []

    constructor() {
        setInterval(() => this.refill(), TOKEN_REFILL_MS).unref?.()
    }

    private refill() {
        if (this.available < TOKEN_CAPACITY) this.available += 1
        while (this.available > 0 && this.waiters.length > 0) {
            this.available -= 1
            const waiter = this.waiters.shift()!
            waiter()
        }
    }

    take(): Promise<void> {
        if (this.available > 0) {
            this.available -= 1
            return Promise.resolve()
        }
        return new Promise((resolve) => this.waiters.push(resolve))
    }
}

const bucket = new TokenBucket()

async function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

async function requestJson(url: string, init: RequestInit, token: string, attempt = 0): Promise<any> {
    await bucket.take()
    const response = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    })
    if (response.status === 429 && attempt < 5) {
        const wait = Math.min(8000, 500 * 2 ** attempt)
        await sleep(wait)
        return requestJson(url, init, token, attempt + 1)
    }
    if (!response.ok) {
        const body = await response.text()
        throw new Error(`Airtable ${response.status} ${init.method ?? 'GET'} ${url}: ${body}`)
    }
    return response.json()
}

function toDoorRecord(raw: { id: string; fields?: Record<string, unknown> }): DoorRecord {
    const fields = raw.fields ?? {}
    const guid = typeof fields.GUID === 'string' ? fields.GUID : ''
    const validRaw = typeof fields.Valid === 'string' ? fields.Valid.trim().toLowerCase() : null
    const valid = validRaw === 'yes' ? 'yes' : validRaw === 'no' ? 'no' : null
    return { id: raw.id, guid, valid, fields }
}

export async function listDoors(
    config: AirtableConfig,
    options: { onlyNonValid?: boolean } = {}
): Promise<DoorRecord[]> {
    const { token, baseId, tableName } = config
    const out: DoorRecord[] = []
    let offset: string | undefined
    do {
        const url = new URL(`${API}/${baseId}/${encodeURIComponent(tableName)}`)
        url.searchParams.set('pageSize', '100')
        if (options.onlyNonValid) {
            url.searchParams.set('filterByFormula', "NOT({Valid} = 'yes')")
        }
        if (offset) url.searchParams.set('offset', offset)
        const data = await requestJson(url.toString(), { method: 'GET' }, token)
        for (const record of data.records ?? []) {
            const door = toDoorRecord(record)
            if (door.guid) out.push(door)
        }
        offset = data.offset
    } while (offset)
    return out
}

/** Clear the named attachment fields on a record before re-uploading. */
export async function clearAttachments(
    config: AirtableConfig,
    recordId: string,
    fieldNames: readonly string[]
): Promise<void> {
    if (fieldNames.length === 0) return
    const fields: Record<string, unknown[]> = {}
    for (const name of fieldNames) fields[name] = []
    await requestJson(
        `${API}/${config.baseId}/${encodeURIComponent(config.tableName)}/${recordId}`,
        { method: 'PATCH', body: JSON.stringify({ fields }) },
        config.token
    )
}

/**
 * Upload a PNG (or any supported attachment) directly into an Airtable field.
 * Appends to whatever is already there — use `clearAttachments` first if you
 * want pure overwrite semantics.
 *
 * https://airtable.com/developers/web/api/upload-attachment
 */
export async function uploadAttachment(
    config: AirtableConfig,
    recordId: string,
    fieldName: string,
    attachment: AttachmentFieldBytes
): Promise<void> {
    const url = `${CONTENT}/${config.baseId}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`
    const body = {
        contentType: attachment.contentType,
        filename: attachment.filename,
        file: attachment.bytes.toString('base64'),
    }
    await requestJson(url, { method: 'POST', body: JSON.stringify(body) }, config.token)
}
