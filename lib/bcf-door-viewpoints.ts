import JSZip from 'jszip'
import sharp from 'sharp'
import * as THREE from 'three'
import type { ElementInfo } from './ifc-types'

export type BCFVector = { X: number; Y: number; Z: number }

export type BCFClippingPlane = {
    location: BCFVector
    direction: BCFVector
}

export interface DoorBCFTopic {
    topicGuid: string
    viewpointGuid: string
    title: string
    ifcGuid: string
    doorNumber: string
    perspectiveCamera: {
        cameraViewPoint: BCFVector
        cameraDirection: BCFVector
        cameraUpVector: BCFVector
        fieldOfView: number
    }
    viewBox: {
        min: BCFVector
        max: BCFVector
    }
    clippingPlanes: BCFClippingPlane[]
}

export interface CameraFitResult {
    camera: THREE.PerspectiveCamera
    target: THREE.Vector3
    viewBox: THREE.Box3
}

export interface BuildBCFZipOptions {
    projectName: string
    ifcFileName: string
    creationDate?: Date
    creationAuthor?: string
}

const THREE_WORLD_UP = new THREE.Vector3(0, 1, 0)
const DEFAULT_ISOMETRIC_DIRECTION = new THREE.Vector3(1, 0.65, -1).normalize()
const MIN_VIEW_SIZE = 1
const VIEWPOINT_FILE_NAME = 'viewpoint.bcfv'
const SNAPSHOT_FILE_NAME = 'snapshot.png'

export function expandBoundingBox(
    box: THREE.Box3,
    expansionFactor = 0.75,
    minViewSize = MIN_VIEW_SIZE
): THREE.Box3 {
    const expanded = box.clone()
    const size = expanded.getSize(new THREE.Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z, minViewSize)

    expanded.expandByScalar(maxDimension * expansionFactor)
    return expanded
}

export function fitCameraToBoundingBox(
    camera: THREE.PerspectiveCamera,
    box: THREE.Box3,
    preferredDirection?: THREE.Vector3
): CameraFitResult {
    const viewBox = box.clone()
    const target = viewBox.getCenter(new THREE.Vector3())
    const size = viewBox.getSize(new THREE.Vector3())
    const sphere = viewBox.getBoundingSphere(new THREE.Sphere())
    const direction = normalizeDirection(preferredDirection)

    const verticalFov = THREE.MathUtils.degToRad(camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
    const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), THREE.MathUtils.degToRad(1))
    const radius = Math.max(sphere.radius, size.length() * 0.5, MIN_VIEW_SIZE * 0.5)
    const distance = (radius / Math.sin(limitingFov / 2)) * 1.05

    const position = target.clone().add(direction.multiplyScalar(distance))

    camera.position.copy(position)
    camera.up.copy(THREE_WORLD_UP)
    camera.near = Math.max(0.01, distance - radius * 3)
    camera.far = distance + radius * 6
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)

    return { camera, target, viewBox }
}

export function createBCFViewpoint(
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3
): DoorBCFTopic['perspectiveCamera'] {
    const cameraDirection = target.clone().sub(camera.position).normalize()
    const cameraUpVector = camera.up.clone().normalize()

    return {
        cameraViewPoint: toBCFPoint(camera.position),
        cameraDirection: toBCFDirection(cameraDirection),
        cameraUpVector: toBCFDirection(cameraUpVector),
        fieldOfView: roundNumber(camera.fov),
    }
}

export function createDoorBCFTopic(params: {
    door: ElementInfo
    ifcGuid: string
    doorNumber: string
    camera: THREE.PerspectiveCamera
    viewBox: THREE.Box3
    target: THREE.Vector3
}): DoorBCFTopic {
    return {
        topicGuid: createUuid(),
        viewpointGuid: createUuid(),
        title: `${sanitizeTopicPart(params.doorNumber)}_${params.ifcGuid}`,
        ifcGuid: params.ifcGuid,
        doorNumber: params.doorNumber,
        perspectiveCamera: createBCFViewpoint(params.camera, params.target),
        viewBox: toBCFBox(params.viewBox),
        clippingPlanes: createClippingPlanesFromBox(params.viewBox),
    }
}

export async function buildBCFZip(
    topics: DoorBCFTopic[],
    options: BuildBCFZipOptions
): Promise<Uint8Array> {
    const zip = new JSZip()
    const createdAt = (options.creationDate ?? new Date()).toISOString()
    const author = options.creationAuthor ?? 'ifc-view-gen'
    const placeholderSnapshot = await createPlaceholderSnapshot()

    zip.file('bcf.version', buildVersionXml())

    for (const topic of topics) {
        const folder = zip.folder(topic.topicGuid)
        if (!folder) continue

        folder.file(
            'markup.bcf',
            buildMarkupXml({
                topic,
                createdAt,
                author,
            })
        )
        folder.file(VIEWPOINT_FILE_NAME, buildViewpointXml(topic))
        folder.file(SNAPSHOT_FILE_NAME, placeholderSnapshot)
    }

    return zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    })
}

async function createPlaceholderSnapshot(): Promise<Uint8Array> {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <rect width="800" height="450" fill="#f2f4f7"/>
  <rect x="48" y="48" width="704" height="354" rx="18" fill="#ffffff" stroke="#c8ced8" stroke-width="2"/>
  <text x="400" y="205" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700" fill="#2f3742">Tür-QS Viewpoint</text>
  <text x="400" y="258" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#6b7280">BCF Ansichtspunkt mit 3D-Kamera</text>
</svg>`

    return sharp(Buffer.from(svg)).png().toBuffer()
}

export function getPreferredDoorViewDirection(door: ElementInfo): THREE.Vector3 {
    const placementYAxis = door.placementYAxis?.clone()
    if (placementYAxis && placementYAxis.lengthSq() > 1e-8) {
        placementYAxis.y = 0
        if (placementYAxis.lengthSq() > 1e-8) return placementYAxis.normalize()
    }

    if (door.boundingBox) {
        const size = door.boundingBox.getSize(new THREE.Vector3())
        if (size.x > size.z * 1.5) return new THREE.Vector3(0, 0, -1)
        if (size.z > size.x * 1.5) return new THREE.Vector3(1, 0, 0)
    }

    return DEFAULT_ISOMETRIC_DIRECTION.clone()
}

export function getWorldBoundingBoxForElement(element: ElementInfo): THREE.Box3 | null {
    if (element.boundingBox && !element.boundingBox.isEmpty()) {
        return element.boundingBox.clone()
    }

    const meshes = element.meshes?.length ? element.meshes : [element.mesh]
    const box = new THREE.Box3()
    let hasBox = false

    for (const mesh of meshes) {
        if (!mesh?.geometry) continue
        mesh.updateWorldMatrix(true, false)
        mesh.geometry.computeBoundingBox()
        if (!mesh.geometry.boundingBox) continue

        const meshBox = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld)
        if (meshBox.isEmpty()) continue

        if (hasBox) box.union(meshBox)
        else {
            box.copy(meshBox)
            hasBox = true
        }
    }

    return hasBox ? box : null
}

function buildVersionXml(): string {
    return xml([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Version VersionId="2.1" p1:noNamespaceSchemaLocation="version.xsd" xmlns:p1="http://www.w3.org/2001/XMLSchema-instance">',
        '  <DetailedVersion>2.1</DetailedVersion>',
        '</Version>',
    ])
}

function buildMarkupXml(params: {
    topic: DoorBCFTopic
    createdAt: string
    author: string
}): string {
    const { topic, createdAt, author } = params
    const commentGuid = createUuid()

    return xml([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        `  <Topic Guid="${escapeXml(topic.topicGuid)}" TopicStatus="Aktiviert">`,
        `    <Title>${escapeXml(topic.title)}</Title>`,
        `    <CreationDate>${escapeXml(createdAt)}</CreationDate>`,
        `    <CreationAuthor>${escapeXml(author)}</CreationAuthor>`,
        `    <ModifiedDate>${escapeXml(createdAt)}</ModifiedDate>`,
        `    <ModifiedAuthor>${escapeXml(author)}</ModifiedAuthor>`,
        '    <AssignedTo>Manuel Emmenegger</AssignedTo>',
        '    <Labels>',
        '      <Label>Türen</Label>',
        '      <Label>QS</Label>',
        '      <Label>Viewpoint-Koordination</Label>',
        '    </Labels>',
        '    <DueDate></DueDate>',
        '    <Description>Themenart:',
        'Information',
        '',
        'viewpoint für Tür-QS</Description>',
        '  </Topic>',
        `  <Comment Guid="${escapeXml(commentGuid)}">`,
        `    <Date>${escapeXml(createdAt)}</Date>`,
        `    <Author>${escapeXml(author)}</Author>`,
        '    <Comment></Comment>',
        `    <Viewpoint Guid="${escapeXml(topic.viewpointGuid)}" />`,
        `    <ModifiedDate>${escapeXml(createdAt)}</ModifiedDate>`,
        `    <ModifiedAuthor>${escapeXml(author)}</ModifiedAuthor>`,
        '  </Comment>',
        `  <Viewpoints Guid="${escapeXml(topic.viewpointGuid)}">`,
        `    <Viewpoint>${VIEWPOINT_FILE_NAME}</Viewpoint>`,
        `    <Snapshot>${SNAPSHOT_FILE_NAME}</Snapshot>`,
        '  </Viewpoints>',
        '</Markup>',
    ])
}

function buildViewpointXml(topic: DoorBCFTopic): string {
    const camera = topic.perspectiveCamera

    return xml([
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<VisualizationInfo Guid="${escapeXml(topic.viewpointGuid)}">`,
        '  <Components>',
        '    <ViewSetupHints SpacesVisible="false" SpaceBoundariesVisible="false" OpeningsVisible="false" />',
        '    <Selection>',
        `      <Component IfcGuid="${escapeXml(topic.ifcGuid)}" />`,
        '    </Selection>',
        '    <Visibility DefaultVisibility="true" />',
        '    <Coloring />',
        '  </Components>',
        '  <PerspectiveCamera>',
        vectorXml('CameraViewPoint', camera.cameraViewPoint, 4),
        vectorXml('CameraDirection', camera.cameraDirection, 4),
        vectorXml('CameraUpVector', camera.cameraUpVector, 4),
        `    <FieldOfView>${camera.fieldOfView}</FieldOfView>`,
        '  </PerspectiveCamera>',
        buildClippingPlanesXml(topic.clippingPlanes),
        '</VisualizationInfo>',
    ])
}

function createClippingPlanesFromBox(box: THREE.Box3): BCFClippingPlane[] {
    const { min, max } = toBCFBox(box)
    const center = {
        X: roundNumber((min.X + max.X) / 2),
        Y: roundNumber((min.Y + max.Y) / 2),
        Z: roundNumber((min.Z + max.Z) / 2),
    }

    return [
        { location: { X: center.X, Y: center.Y, Z: max.Z }, direction: { X: 0, Y: 0, Z: 1 } },
        { location: { X: center.X, Y: center.Y, Z: min.Z }, direction: { X: 0, Y: 0, Z: -1 } },
        { location: { X: max.X, Y: center.Y, Z: center.Z }, direction: { X: 1, Y: 0, Z: 0 } },
        { location: { X: min.X, Y: center.Y, Z: center.Z }, direction: { X: -1, Y: 0, Z: 0 } },
        { location: { X: center.X, Y: min.Y, Z: center.Z }, direction: { X: 0, Y: -1, Z: 0 } },
        { location: { X: center.X, Y: max.Y, Z: center.Z }, direction: { X: 0, Y: 1, Z: 0 } },
    ]
}

function buildClippingPlanesXml(clippingPlanes: BCFClippingPlane[]): string {
    const lines = ['  <ClippingPlanes>']

    for (const clippingPlane of clippingPlanes) {
        lines.push('    <ClippingPlane>')
        lines.push(vectorXml('Location', clippingPlane.location, 6))
        lines.push(vectorXml('Direction', clippingPlane.direction, 6))
        lines.push('    </ClippingPlane>')
    }

    lines.push('  </ClippingPlanes>')
    return lines.join('\n')
}

function vectorXml(tagName: string, vector: BCFVector, indent = 0): string {
    const pad = ' '.repeat(indent)
    return [
        `${pad}<${tagName}>`,
        `${pad}  <X>${vector.X}</X>`,
        `${pad}  <Y>${vector.Y}</Y>`,
        `${pad}  <Z>${vector.Z}</Z>`,
        `${pad}</${tagName}>`,
    ].join('\n')
}

function normalizeDirection(direction: THREE.Vector3 | undefined): THREE.Vector3 {
    const normalized = direction?.clone() ?? DEFAULT_ISOMETRIC_DIRECTION.clone()
    if (normalized.lengthSq() < 1e-8) return DEFAULT_ISOMETRIC_DIRECTION.clone()
    return normalized.normalize()
}

function toBCFPoint(vector: THREE.Vector3): BCFVector {
    // web-ifc geometry is consumed here in Three.js coordinates (Y-up).
    // BCF viewpoints use IFC coordinates (Z-up), so invert the loader rotation:
    // Three (x, y, z) -> BCF/IFC (x, -z, y).
    return {
        X: roundNumber(vector.x),
        Y: roundNumber(-vector.z),
        Z: roundNumber(vector.y),
    }
}

function toBCFDirection(vector: THREE.Vector3): BCFVector {
    return toBCFPoint(vector)
}

function toBCFBox(box: THREE.Box3): { min: BCFVector; max: BCFVector } {
    const points = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ].map(toBCFPoint)

    return {
        min: {
            X: Math.min(...points.map((point) => point.X)),
            Y: Math.min(...points.map((point) => point.Y)),
            Z: Math.min(...points.map((point) => point.Z)),
        },
        max: {
            X: Math.max(...points.map((point) => point.X)),
            Y: Math.max(...points.map((point) => point.Y)),
            Z: Math.max(...points.map((point) => point.Z)),
        },
    }
}

function roundNumber(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Number.parseFloat(value.toFixed(6))
}

function sanitizeTopicPart(value: string): string {
    return value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_') || 'door'
}

function createUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
        const random = Math.floor(Math.random() * 16)
        const value = char === 'x' ? random : (random & 0x3) | 0x8
        return value.toString(16)
    })
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

function xml(lines: string[]): string {
    return `${lines.join('\n')}\n`
}
