import mods from './modules/module2.js'

self.postMessage({
  type: 'classic-worker-import',
  content: JSON.stringify(mods)
})

let base = `/${self.location.pathname.split('/')[1]}`
if (base === `/worker-entries`) base = '' // relative base

importScripts(`${base}/classic.js`)

self.addEventListener('message', () => {
  self.postMessage({
    type: 'classic-worker-import-script',
    content: self.constant
  })
})

// for sourcemap
console.log("classic-worker.js")
