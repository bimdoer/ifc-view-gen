/**
 * web-ifc writes noisy `[WEB-IFC]` lines to stdout/stderr. Filter them before
 * ts-node loads the IFC parser so the generation summary stays readable.
 */
function installWebIfcConsoleNoiseFilter() {
    const marker = '[WEB-IFC]'

    function patchStream(stream) {
        const origWrite = stream.write.bind(stream)
        let buffer = ''

        stream.write = function webIfcWriteFilter(chunk, encoding, cb) {
            const realCb = typeof encoding === 'function' ? encoding : cb
            const text = typeof chunk === 'string'
                ? chunk
                : Buffer.isBuffer(chunk)
                    ? chunk.toString('utf8')
                    : Buffer.from(chunk).toString('utf8')

            buffer += text
            let newlineIndex
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex + 1)
                buffer = buffer.slice(newlineIndex + 1)
                if (!line.includes(marker)) origWrite(line)
            }

            if (buffer.length > 1_000_000) {
                if (!buffer.includes(marker)) origWrite(buffer)
                buffer = ''
            }

            if (typeof realCb === 'function') realCb()
            return true
        }
    }

    patchStream(process.stdout)
    patchStream(process.stderr)
}

installWebIfcConsoleNoiseFilter()

require('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: {
        module: 'commonjs',
        moduleResolution: 'node',
        target: 'es2020',
        esModuleInterop: true,
    },
})

require('./generate-door-bcf.ts')
