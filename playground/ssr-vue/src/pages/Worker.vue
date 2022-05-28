<template>
  {{ msg }}
</template>
<script setup>
import { ref } from 'vue'
const msg = ref('')
if (!import.meta.env.SSR) {
  const worker = new Worker(new URL('./worker.js', import.meta.url))
  worker.addEventListener('message', (e) => {
    msg.value = e.data
  })
}
</script>
