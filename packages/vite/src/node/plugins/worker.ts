import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import MagicString from 'magic-string'
import type { EmittedAsset, OutputChunk, RollupCache } from 'rollup'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import type { ViteDevServer } from '../server'
import { ENV_ENTRY, ENV_PUBLIC_PATH } from '../constants'
import {
  cleanUrl,
  createDebugger,
  getDepsCacheSuffix,
  getHash,
  injectQuery,
  normalizePath,
  parseRequest
} from '../utils'
import {
  createToImportMetaURLBasedRelativeRuntime,
  onRollupWarning,
  toOutputFilePathInJS
} from '../build'
import { getDepsOptimizer } from '../optimizer'

const debug = createDebugger('vite:worker')

interface WorkerCache {
  cache?: RollupCache

  // save worker all emit chunk avoid rollup make the same asset unique.
  assets: Map<string, EmittedAsset>

  // worker bundle don't deps on any more worker runtime info an id only had a result.
  // save worker bundled file id to avoid repeated execution of bundles
  // <input_filename, fileName>
  bundle: Map<string, string>

  // <hash, fileName>
  fileNameHash: Map<string, string>
}

export type WorkerType = 'classic' | 'module' | 'ignore'

const WORKER_FILE_ID = 'worker_file'
const WORKER_PREFIX = '/@worker/'
const VOLUME_RE = /^[A-Z]:/i
const workerCache = new WeakMap<ResolvedConfig, WorkerCache>()

export function isWorkerRequest(id: string): boolean {
  const query = parseRequest(id)
  if (query && query[WORKER_FILE_ID] != null) {
    return true
  }
  return false
}

function saveEmitWorkerAsset(
  config: ResolvedConfig,
  asset: EmittedAsset
): void {
  const fileName = asset.fileName!
  const workerMap = workerCache.get(config.mainConfig || config)!
  workerMap.assets.set(fileName, asset)
}

function mergeRollupCache(
  o?: RollupCache,
  n?: RollupCache
): RollupCache | undefined {
  return {
    modules: (o?.modules || []).concat(n?.modules || []),
    plugins: Object.assign({}, o?.plugins, n?.plugins)
  }
}

function workerPathFromUrl(url: string): string {
  const id = cleanUrl(url)
  const fsPath = normalizePath(
    id.startsWith(WORKER_PREFIX) ? id.slice(WORKER_PREFIX.length) : id
  )
  return fsPath.startsWith('/') || fsPath.match(VOLUME_RE)
    ? fsPath
    : `/${fsPath}`
}

export async function bundleWorkerEntry(
  config: ResolvedConfig,
  id: string,
  query: Record<string, string> | null
): Promise<OutputChunk> {
  // bundle the file as entry to support imports
  const isBuild = config.command === 'build'
  const { rollup } = await import('rollup')
  const { plugins, rollupOptions, format } = config.worker
  const workerMap = workerCache.get(config.mainConfig || config)!
  const cleanInput = cleanUrl(id)
  const relativeDirPath = path.dirname(path.relative(config.root, cleanInput))
  const bundle = await rollup({
    ...rollupOptions,
    cache: workerMap.cache,
    input: cleanInput,
    plugins,
    onwarn(warning, warn) {
      onRollupWarning(warning, warn, config)
    },
    preserveEntrySignatures: false
  }).catch((err) => {
    throw err
  })

  workerMap.cache = mergeRollupCache(workerMap.cache, bundle.cache)
  let chunk: OutputChunk
  try {
    const workerOutputConfig = config.worker.rollupOptions.output
    const workerConfig = workerOutputConfig
      ? Array.isArray(workerOutputConfig)
        ? workerOutputConfig[0] || {}
        : workerOutputConfig
      : {}
    const {
      output: [outputChunk, ...outputChunks]
    } = await bundle.generate({
      entryFileNames: path.posix.join(
        config.build.assetsDir,
        '[name].[hash].js'
      ),
      chunkFileNames: path.posix.join(
        config.build.assetsDir,
        '[name].[hash].js'
      ),
      assetFileNames: path.posix.join(
        config.build.assetsDir,
        '[name].[hash].[ext]'
      ),
      ...workerConfig,
      format,
      sourcemap: config.build.sourcemap,
      ...(!isBuild
        ? {
            entryFileNames: path.join(relativeDirPath, '[name].js'),
            chunkFileNames: path.join(relativeDirPath, '[name].js'),
            assetFileNames: path.join(relativeDirPath, '[name].[ext]')
          }
        : {})
    })
    chunk = outputChunk
    outputChunks.forEach((outputChunk) => {
      if (outputChunk.type === 'asset') {
        saveEmitWorkerAsset(config, outputChunk)
      } else if (outputChunk.type === 'chunk') {
        saveEmitWorkerAsset(config, {
          fileName: outputChunk.fileName,
          source: outputChunk.code,
          type: 'asset'
        })
      }
    })
  } finally {
    await bundle.close()
  }
  return emitSourcemapForWorkerEntry(config, query, chunk)
}

function emitSourcemapForWorkerEntry(
  config: ResolvedConfig,
  query: Record<string, string> | null,
  chunk: OutputChunk
): OutputChunk {
  const { map: sourcemap } = chunk

  if (sourcemap) {
    if (config.build.sourcemap === 'inline') {
      // Manually add the sourcemap to the code if configured for inline sourcemaps.
      // TODO: Remove when https://github.com/rollup/rollup/issues/3913 is resolved
      // Currently seems that it won't be resolved until Rollup 3
      const dataUrl = sourcemap.toUrl()
      chunk.code += `//# sourceMappingURL=${dataUrl}`
    } else if (
      config.build.sourcemap === 'hidden' ||
      config.build.sourcemap === true
    ) {
      const data = sourcemap.toString()
      const mapFileName = chunk.fileName + '.map'
      saveEmitWorkerAsset(config, {
        fileName: mapFileName,
        type: 'asset',
        source: data
      })

      // Emit the comment that tells the JS debugger where it can find the
      // sourcemap file.
      // 'hidden' causes the sourcemap file to be created but
      // the comment in the file to be omitted.
      if (config.build.sourcemap === true) {
        // inline web workers need to use the full sourcemap path
        // non-inline web workers can use a relative path
        const sourceMapUrl =
          query?.inline != null
            ? mapFileName
            : path.relative(config.build.assetsDir, mapFileName)
        chunk.code += `//# sourceMappingURL=${sourceMapUrl}`
      }
    }
  }

  return chunk
}

export const workerAssetUrlRE = /__VITE_WORKER_ASSET__([a-z\d]{8})__/g

function encodeWorkerAssetFileName(
  fileName: string,
  workerCache: WorkerCache
): string {
  const { fileNameHash } = workerCache
  const hash = getHash(fileName)
  if (!fileNameHash.get(hash)) {
    fileNameHash.set(hash, fileName)
  }
  return `__VITE_WORKER_ASSET__${hash}__`
}

async function workerFileToBuiltUrl(
  config: ResolvedConfig,
  id: string,
  query: Record<string, string> | null
): Promise<string> {
  const workerMap = workerCache.get(config.mainConfig || config)!
  let fileName = workerMap.bundle.get(id)
  if (!fileName) {
    const outputChunk = await bundleWorkerEntry(config, id, query)
    fileName = outputChunk.fileName
    saveEmitWorkerAsset(config, {
      fileName,
      source: outputChunk.code,
      type: 'asset'
    })
    workerMap.bundle.set(id, fileName)
  }
  return encodeWorkerAssetFileName(fileName, workerMap)
}

async function workerFileToDevUrl(
  config: ResolvedConfig,
  id: string,
  query: Record<string, string> | null,
  workerType: WorkerType
): Promise<string> {
  let url = path.posix.join(WORKER_PREFIX + cleanUrl(id))
  url = config.server?.origin ?? '' + config.base + url.replace(/^\//, '')
  url = injectQuery(url, WORKER_FILE_ID)
  url = injectQuery(url, `type=${workerType}`)
  return url
}

export async function workerFileToUrl(
  config: ResolvedConfig,
  id: string,
  query: Record<string, string> | null,
  workerType: WorkerType
): Promise<string> {
  if (config.command === 'serve') {
    return workerFileToDevUrl(config, id, query, workerType)
  } else {
    return workerFileToBuiltUrl(config, id, query)
  }
}

export function webWorkerPlugin(config: ResolvedConfig): Plugin {
  const isBuild = config.command === 'build'
  let server: ViteDevServer
  const isWorker = config.isWorker
  const cacheFilePath = path.join(
    config.cacheDir,
    getDepsCacheSuffix(config, !!config.build.ssr) + '_worker_cache.json'
  )

  return {
    name: 'vite:worker',

    configureServer(_server) {
      server = _server
    },

    async buildStart() {
      if (isWorker) {
        return
      }
      let cache!: RollupCache
      if (existsSync(cacheFilePath)) {
        cache = JSON.parse(
          await fsp.readFile(cacheFilePath, { encoding: 'utf-8' })
        )
      } else {
        cache = {
          modules: []
        }
      }
      workerCache.set(config, {
        cache,
        assets: new Map(),
        bundle: new Map(),
        fileNameHash: new Map()
      })
    },

    async buildEnd() {
      if (isWorker) {
        return
      }
      await fsp.mkdir(config.cacheDir, { recursive: true })
      await fsp.writeFile(
        cacheFilePath,
        JSON.stringify(workerCache.get(config)?.cache || '')
      )
    },

    resolveId(id, importer) {
      // resolve worker virtual module (/@worker/*) deps named
      if (importer && importer.startsWith(WORKER_PREFIX)) {
        const res = path.join(path.dirname(cleanUrl(importer)), id)
        debug('[resolveId]', id, '->', res)
        return res
      }
    },

    async load(id) {
      const query = parseRequest(id)
      // ?worker ?sharedworker
      if (query && (query.worker ?? query.sharedworker) != null) {
        return ''
      }
      // /@worker/*
      if (id.startsWith(WORKER_PREFIX)) {
        const input = workerPathFromUrl(id)
        const workerMap = workerCache.get(config.mainConfig || config)!
        if (query && query[WORKER_FILE_ID] != null) {
          debug('[bundle]', id)
          if (!workerMap.bundle.get(id)) {
            const outputChunk = await bundleWorkerEntry(config, input, query)
            workerMap.assets.set(id, {
              fileName: outputChunk.fileName,
              source: outputChunk.code,
              type: 'asset'
            })
            workerMap.bundle.set(id, outputChunk.fileName)
          }
          const outputChunk = workerMap.assets.get(id)!
          // if import worker by worker constructor will have query.type
          // other type will be import worker by esm
          const workerType = query!['type']! as WorkerType
          let injectEnv = ''

          if (workerType === 'classic') {
            injectEnv = `importScripts('${ENV_PUBLIC_PATH}');\n`
          } else if (workerType === 'module') {
            injectEnv = `import '${ENV_PUBLIC_PATH}';\n`
          } else if (workerType === 'ignore') {
            if (isBuild) {
              injectEnv = ''
            } else if (server) {
              // dynamic worker type we can't know how import the env
              // so we copy /@vite/env code of server transform result into file header
              const { moduleGraph } = server
              const module = moduleGraph.getModuleById(ENV_ENTRY)
              injectEnv = module?.transformResult?.code || ''
            }
          }
          return injectEnv + outputChunk.source
        } else {
          debug('[load module id]', id)
          return workerMap.assets.get(
            path.relative(WORKER_PREFIX + config.root, id)
          )?.source as string
        }
      }
    },

    async transform(raw, id, options) {
      const ssr = options?.ssr === true
      const query = parseRequest(id)
      if (
        query == null ||
        (query && (query.worker ?? query.sharedworker) == null)
      ) {
        return
      }
      // stringified url or `new URL(...)`
      const { format } = config.worker
      const workerConstructor =
        query.sharedworker != null ? 'SharedWorker' : 'Worker'
      const workerType = isBuild
        ? format === 'es'
          ? 'module'
          : 'classic'
        : 'module'
      const workerOptions = workerType === 'classic' ? '' : ',{type: "module"}'
      if (isBuild) {
        getDepsOptimizer(config, ssr)?.registerWorkersSource(id)
        if (query.inline != null) {
          const chunk = await bundleWorkerEntry(config, id, query)
          // inline as blob data url
          return {
            code: `const encodedJs = "${Buffer.from(chunk.code).toString(
              'base64'
            )}";
            const blob = typeof window !== "undefined" && window.Blob && new Blob([atob(encodedJs)], { type: "text/javascript;charset=utf-8" });
            export default function WorkerWrapper() {
              const objURL = blob && (window.URL || window.webkitURL).createObjectURL(blob);
              try {
                return objURL ? new ${workerConstructor}(objURL) : new ${workerConstructor}("data:application/javascript;base64," + encodedJs${workerOptions});
              } finally {
                objURL && (window.URL || window.webkitURL).revokeObjectURL(objURL);
              }
            }`,

            // Empty sourcemap to suppress Rollup warning
            map: { mappings: '' }
          }
        }
      }
      const url = await workerFileToUrl(config, id, query, workerType)
      debug('[transform]', id)
      if (query.url != null) {
        return {
          code: `export default ${JSON.stringify(url)}`,
          map: { mappings: '' } // Empty sourcemap to suppress Rollup warning
        }
      }

      return {
        code: `export default function WorkerWrapper() {
          return new ${workerConstructor}(${JSON.stringify(
          url
        )}${workerOptions})
        }`,
        map: { mappings: '' } // Empty sourcemap to suppress Rollup warning
      }
    },

    renderChunk(code, chunk, outputOptions) {
      let s: MagicString
      const result = () => {
        return (
          s && {
            code: s.toString(),
            map: config.build.sourcemap ? s.generateMap({ hires: true }) : null
          }
        )
      }
      if (code.match(workerAssetUrlRE) || code.includes('import.meta.url')) {
        const toRelativeRuntime = createToImportMetaURLBasedRelativeRuntime(
          outputOptions.format
        )

        let match: RegExpExecArray | null
        s = new MagicString(code)

        // Replace "__VITE_WORKER_ASSET__5aa0ddc0__" using relative paths
        const workerMap = workerCache.get(config.mainConfig || config)!
        const { fileNameHash } = workerMap

        while ((match = workerAssetUrlRE.exec(code))) {
          const [full, hash] = match
          const filename = fileNameHash.get(hash)!
          const replacement = toOutputFilePathInJS(
            filename,
            'asset',
            chunk.fileName,
            'js',
            config,
            toRelativeRuntime
          )
          const replacementString =
            typeof replacement === 'string'
              ? JSON.stringify(replacement).slice(1, -1)
              : `"+${replacement.runtime}+"`
          s.update(match.index, match.index + full.length, replacementString)
        }
      }
      return result()
    },

    generateBundle(opts) {
      // @ts-ignore asset emits are skipped in legacy bundle
      if (opts.__vite_skip_asset_emit__ || isWorker) {
        return
      }
      const workerMap = workerCache.get(config)!
      workerMap.assets.forEach((asset) => {
        this.emitFile(asset)
        workerMap.assets.delete(asset.fileName!)
      })
    }
  }
}
