/**
 * Rasterize an SVG string to a WebP file in Node (uses sharp + librsvg).
 * For browser-only conversion see `svg-to-webp.ts` (data URL).
 */

import sharp from 'sharp'

export interface SvgToWebpFileOptions {
    /** WebP quality 1–100 (default 92) */
    quality?: number
    /** SVG rasterization DPI; higher = sharper text/legend (default 300) */
    density?: number
}

/**
 * Writes `outputPath` as WebP. Input must be a valid SVG document string.
 */
export async function writeSvgStringAsWebp(
    svg: string,
    outputPath: string,
    options?: SvgToWebpFileOptions
): Promise<void> {
    const quality = options?.quality ?? 92
    const density = options?.density ?? 300
    await sharp(Buffer.from(svg, 'utf8'), { density })
        .webp({ quality, effort: 4 })
        .toFile(outputPath)
}
