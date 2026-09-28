import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';

import CaptureCallouts from './CaptureCallouts.vue';
import DocSources from './DocSources.vue';
import DocStatus from './DocStatus.vue';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-before': () => h(DocStatus),
      'doc-footer-before': () => h(DocSources),
    }),
  enhanceApp({ app }) {
    app.component('CaptureCallouts', CaptureCallouts);
  },
} satisfies Theme;
