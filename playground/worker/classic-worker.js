let base = `/${self.location.pathname.split('/')[1]}`
if (base === `/worker-entries`) base = '' // relative base

importScripts(`${base}/classic.js`)

self.addEventListener('message', () => {
  self.postMessage({
    type: 'classic-worker-import-script',
    content: self.constant
  })
})

import('./modules/module0.js').then(module0 => {
  self.postMessage({
    type: 'classic-worker-import',
    content: module0.default
  })
})

// for sourcemap
console.log("classic-worker.js")
