import path from 'path'
import JSON5 from 'json5'
import MagicString from 'magic-string'
import type { RollupError } from 'rollup'
import { stripLiteral } from 'strip-literal'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import { cleanUrl, injectQuery, normalizePath, transformResult } from '../utils'
import { getDepsOptimizer } from '../optimizer'
import type { WorkerFormat, WorkerType } from './worker'
import { WORKER_FILE_ID, parseWorkerQuery, workerFileToUrl } from './worker'
import { fileToUrl } from './asset'

const ignoreFlagRE = /\/\*\s*@vite-ignore\s*\*\//

function getWorkerType(raw: string, clean: string, i: number): WorkerType {
  function err(e: string, pos: number) {
    const error = new Error(e) as RollupError
    error.pos = pos
    throw error
  }

  const commaIndex = clean.indexOf(',', i)
  if (commaIndex === -1) {
    return 'classic'
  }
  const endIndex = clean.indexOf(')', i)

  // case: ') ... ,' mean no worker options params
  if (commaIndex > endIndex) {
    return 'classic'
  }

  // need to find in comment code
  const workerOptString = raw.substring(commaIndex + 1, endIndex)

  const hasViteIgnore = ignoreFlagRE.test(workerOptString)
  if (hasViteIgnore) {
    return 'ignore'
  }

  // need to find in no comment code
  const cleanWorkerOptString = clean.substring(commaIndex + 1, endIndex)
  if (!cleanWorkerOptString.trim().length) {
    return 'classic'
  }

  let workerOpts: { type: WorkerType } = { type: 'classic' }
  try {
    workerOpts = JSON5.parse(workerOptString)
  } catch (e) {
    // can't parse by JSON5, so the worker options had unexpect char.
    err(
      'Vite is unable to parse the worker options as the value is not static.' +
        'To ignore this error, please use /* @vite-ignore */ in the worker options.',
      commaIndex + 1
    )
  }

  if (['classic', 'module'].includes(workerOpts.type)) {
    return workerOpts.type
  }
  return 'classic'
}

function workerTypeToFormat(
  config: ResolvedConfig,
  type: WorkerType
): WorkerFormat {
  return (
    ({
      module: 'es',
      classic: 'iife',
      ignore: config.worker.format
    }[type] as WorkerFormat) || config.worker.format
  )
}

export function workerImportMetaUrlPlugin(config: ResolvedConfig): Plugin {
  const isBuild = config.command === 'build'

  return {
    name: 'vite:worker-import-meta-url',

    async transform(code, id, options) {
      const query = parseWorkerQuery(id)
      let s: MagicString | undefined
      if (
        (code.includes('new Worker') || code.includes('new SharedWorker')) &&
        code.includes('new URL') &&
        code.includes(`import.meta.url`)
      ) {
        const cleanString = stripLiteral(code)
        const workerImportMetaUrlRE =
          /\bnew\s+(Worker|SharedWorker)\s*\(\s*(new\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*import\.meta\.url\s*\))/g

        let match: RegExpExecArray | null
        while ((match = workerImportMetaUrlRE.exec(cleanString))) {
          const { 0: allExp, 2: exp, 3: emptyUrl, index } = match
          const urlIndex = allExp.indexOf(exp) + index

          const urlStart = cleanString.indexOf(emptyUrl, index)
          const urlEnd = urlStart + emptyUrl.length
          const rawUrl = code.slice(urlStart, urlEnd)

          if (options?.ssr) {
            this.error(
              `\`new URL(url, import.meta.url)\` is not supported in SSR.`,
              urlIndex
            )
          }

          // potential dynamic template string
          if (rawUrl[0] === '`' && /\$\{/.test(rawUrl)) {
            this.error(
              `\`new URL(url, import.meta.url)\` is not supported in dynamic template string.`,
              urlIndex
            )
          }

          s ||= new MagicString(code)
          query.type = getWorkerType(code, cleanString, index + allExp.length)
          const file = normalizePath(
            path.resolve(path.dirname(id), rawUrl.slice(1, -1))
          )

          let url: string
          if (isBuild) {
            getDepsOptimizer(config)?.registerWorkersSource(id)
            query.type === 'module'
            url = await workerFileToUrl(config, file, {
              inline: query.inline,
              format: workerTypeToFormat(config, query.type)
            })
          } else {
            url = await fileToUrl(cleanUrl(file), config, this)
            url = injectQuery(url, WORKER_FILE_ID)
            url = injectQuery(url, `type=${query.type}`)
          }
          s.overwrite(urlIndex, urlIndex + exp.length, JSON.stringify(url), {
            contentOnly: true
          })
        }

        if (s) {
          return transformResult(s, id, config)
        }

        return null
      }
    }
  }
}
