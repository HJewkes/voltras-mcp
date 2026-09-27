<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';

import { formatVerifiedDate } from './status';

const REPO_BLOB = 'https://github.com/HJewkes/voltras-mcp/blob/main/';

const { frontmatter } = useData();
const sources = computed<string[]>(() => {
  const value: unknown = frontmatter.value.sources;
  return Array.isArray(value) ? value.map(String) : [];
});
const verified = computed(() => formatVerifiedDate(frontmatter.value.lastVerified));
</script>

<template>
  <section v-if="sources.length > 0 || verified" class="doc-sources" aria-label="Sources">
    <p v-if="sources.length > 0" class="doc-sources-title">Sources</p>
    <ul v-if="sources.length > 0">
      <li v-for="path in sources" :key="path">
        <a :href="REPO_BLOB + path"
          ><code>{{ path }}</code></a
        >
      </li>
    </ul>
    <p v-if="verified" class="doc-sources-verified">Verified {{ verified }}</p>
  </section>
</template>

<style scoped>
.doc-sources {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.doc-sources-title {
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.doc-sources ul {
  margin: 8px 0;
  padding-left: 20px;
  list-style: disc;
}
.doc-sources a {
  color: var(--vp-c-brand-1);
}
</style>
