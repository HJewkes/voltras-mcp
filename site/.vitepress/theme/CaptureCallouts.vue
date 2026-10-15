<script setup lang="ts">
import { computed } from 'vue';
import { withBase } from 'vitepress';

import manifest from '../../public/captures/manifest.json';

/**
 * One numbered legend item. `quote` must be a string the shot's capture asserted
 * (`expectText` or `expectValues` in `src/docs/capture-shots.ts`), so a legend can
 * only point at text the harness proved is on the image (captures.test.ts).
 */
interface Callout {
  readonly quote: string;
  readonly text: string;
}

const props = defineProps<{ shot: string; callouts: readonly Callout[] }>();

const entry = computed(() => manifest.shots.find((shot) => shot.name === props.shot));
const src = computed(() => withBase(`/captures/${props.shot}.png`));
</script>

<template>
  <figure class="capture-callouts">
    <img
      :src="src"
      :alt="entry?.caption ?? props.shot"
      :width="entry?.width"
      :height="entry?.height"
      loading="lazy"
    />
    <ol class="capture-callouts-legend">
      <li v-for="(callout, index) in props.callouts" :key="callout.quote">
        <span class="capture-callouts-number" aria-hidden="true">{{ index + 1 }}</span>
        <span
          ><code>{{ callout.quote }}</code> {{ callout.text }}</span
        >
      </li>
    </ol>
  </figure>
</template>

<style scoped>
.capture-callouts {
  margin: 16px 0;
}
.capture-callouts img {
  width: 100%;
  height: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
.capture-callouts-legend {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.capture-callouts-legend li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin: 6px 0;
}
.capture-callouts-number {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-size: 12px;
  font-weight: 600;
  line-height: 22px;
  text-align: center;
}
</style>
