/**
 * Lädt .env und führt upload-plan-webp-to-airtable.ts mit ts-node aus.
 */

require('dotenv').config()

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

require('./upload-plan-webp-to-airtable.ts')
