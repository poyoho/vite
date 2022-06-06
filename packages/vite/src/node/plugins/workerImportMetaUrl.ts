import path from 'path'
import MagicString from 'magic-string'
import { stripLiteral } from 'strip-literal'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import {
  cleanUrl,
  injectQuery,
  normalizePath,
  parseRequest,
  transformResult
} from '../utils'
import { WORKER_MODULE_REDIRECT , workerFileToUrl } from './worker'
import { fileToUrl } from './asset'
import { registerWorkersSource } from './optimizedDeps'

export function workerImportMetaUrlPlugin(config: ResolvedConfig): Plugin {
  const isBuild = config.command === 'build'

  return {
    name: 'vite:worker-import-meta-url',

    async transform(code, id, options) {
      const query = parseRequest(id)
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
          const file = normalizePath(
            path.resolve(path.dirname(id), rawUrl.slice(1, -1))
          )

          let url: string
          if (isBuild) {
            registerWorkersSource(config, id)
            url = await workerFileToUrl(config, file, query)
          } else {
            url = await fileToUrl(cleanUrl(file), config, this)
            url = injectQuery(url, WORKER_MODULE_REDIRECT)
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
