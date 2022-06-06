let base = `/${self.location.pathname.split('/')[1]}`
if (base === `/worker-entries`) base = '' // relative base

importScripts(`${base}/classic.js`)

self.addEventListener('message', () => {
  self.postMessage({
    type: 'classic-worker-import-script',
    content: self.constant
  })
})

import('./modules/module2.js').then(mods => {
  self.postMessage({
    type: 'classic-worker-import',
    content: JSON.stringify(mods)
  })
})

// for sourcemap
console.log("classic-worker.js")
