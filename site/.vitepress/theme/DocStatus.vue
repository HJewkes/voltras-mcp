<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

import { statusLabel } from './status';

const { frontmatter } = useData();
const label = computed(() => statusLabel(frontmatter.value.status));
const note = computed(() => String(frontmatter.value.statusNote ?? ''));
const tracking = computed(() => String(frontmatter.value.tracking ?? ''));
const trackingIsUrl = computed(() => /^https?:\/\//.test(tracking.value));
</script>

<template>
  <div v-if="label" class="doc-status">
    <a :href="withBase('/status')" class="doc-status-badge">
      <Badge :type="label.badgeType" :text="label.text" />
    </a>
    <div class="info custom-block">
      <p class="custom-block-title">{{ label.text }}</p>
      <p>{{ note }}</p>
      <p v-if="tracking">
        Tracking:
        <a v-if="trackingIsUrl" :href="tracking">{{ tracking }}</a>
        <span v-else>{{ tracking }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.doc-status {
  margin-bottom: 24px;
}
.doc-status .custom-block {
  margin-top: 8px;
}
.doc-status-badge {
  text-decoration: none;
}
.doc-status-badge :deep(.VPBadge) {
  margin-left: 0;
  font-size: 14px;
}
</style>
