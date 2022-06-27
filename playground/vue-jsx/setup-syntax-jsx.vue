<script setup lang="jsx">
import { ref } from 'vue'
import RenderComp from './RenderComp'
import ExtractComp from './Comp'

let count = ref(100)
const increment = () => {
  count.value++
}
const Render = () => (
  <div>
    <button onClick={increment}> click!!! </button>
  </div>
)
const label = () => <div>label</div>
</script>

<template>
  <p class="setup-jsx">{{ count }}</p>
  <Render />
  <RenderComp :label="label" />
  <ExtractComp />
</template>
