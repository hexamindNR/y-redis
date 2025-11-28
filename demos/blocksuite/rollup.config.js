import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import postcss from 'rollup-plugin-postcss'
import alias from '@rollup/plugin-alias'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default [{
  input: './client/main.js',
  output: {
    name: 'test',
    dir: 'dist',
    format: 'esm',
    sourcemap: true
  },
  context: 'globalThis',
  onwarn(warning, warn) {
    // Suppress warnings from node_modules (third-party packages)
    if (warning.id?.includes('node_modules')) {
      return
    }
    // Suppress circular dependency warnings from third-party packages
    if (warning.code === 'CIRCULAR_DEPENDENCY' && warning.ids?.every(id => id.includes('node_modules'))) {
      return
    }
    // Suppress eval warnings from third-party packages
    if (warning.code === 'EVAL' && warning.id?.includes('node_modules')) {
      return
    }
    warn(warning)
  },
  plugins: [
    alias({
      entries: [
        { find: 'yjs', replacement: resolve(__dirname, '../../node_modules/yjs/dist/yjs.mjs') }
      ]
    }),
    nodeResolve({
      mainFields: ['module', 'browser', 'main'],
      preferBuiltins: true
    }),
    commonjs(),
    json(),
    postcss()
  ]
}]
