// prettier-ignore
function text(el, text) {
  document.querySelector(el).textContent = text
}

let classicWorker = new Worker(
  new URL('../classic-worker.js', import.meta.url) /* , */
  // test comment
)

// just test for case: ') ... ,' mean no worker options parmas
classicWorker = new Worker(new URL('../classic-worker.js', import.meta.url))

classicWorker.addEventListener('message', ({ data, type }) => {
  text(`.${data.type}`, JSON.stringify(data.content))
})

// worker module redirect need time to load worker script
setTimeout(() => {
  classicWorker.postMessage('ping')
}, 400)

const classicSharedWorker = new SharedWorker(
  new URL('../classic-shared-worker.js', import.meta.url),
  {
    type: 'classic'
  }
)
classicSharedWorker.port.addEventListener('message', (ev) => {
  text('.classic-shared-worker', JSON.stringify(ev.data))
})
classicSharedWorker.port.start()
