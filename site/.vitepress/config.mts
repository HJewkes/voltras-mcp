import { defineConfig } from 'vitepress';
// Emitted by `npm run docs:reference` alongside the reference pages themselves,
// so a new tool namespace never needs a hand edit here.
import referenceSidebar from './reference-sidebar.json';
import { statusSearchOptions } from './search-status';

// GitHub Pages serves this as a project site under /voltras-mcp/, not the
// repo root, so every asset/link needs that prefix baked in.
export default defineConfig({
  title: 'voltras-mcp',
  description:
    'An MCP server that turns a Voltra digital-resistance trainer into something Claude can drive.',
  base: '/voltras-mcp/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/voltras-mcp/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'icon', href: '/voltras-mcp/favicon.png', type: 'image/png', sizes: '32x32' }],
  ],

  themeConfig: {
    logo: { src: '/logo.svg', alt: 'voltras-mcp' },
    // Badged pages carry their status word into search results (VMCP-07.02).
    search: { provider: 'local', options: statusSearchOptions },
    lastUpdated: { text: 'Last updated' },
    editLink: {
      pattern: 'https://github.com/HJewkes/voltras-mcp/edit/main/site/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Henry Jewkes',
    },

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Install and run', link: '/install-and-run' },
      { text: 'Capability reference', link: '/reference/' },
      { text: 'Guides', link: '/guides/' },
      { text: 'Understand your data', link: '/concepts/' },
      { text: 'For coaches', link: '/coaches/' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'Changelog', link: '/changelog' },
      { text: 'Status', link: '/status' },
    ],

    sidebar: [
      {
        text: 'Docs',
        items: [
          { text: 'Install and run', link: '/install-and-run' },
          { text: 'Guides', link: '/guides/' },
          { text: 'Roadmap', link: '/roadmap' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
      {
        text: 'Understand your data',
        items: [
          { text: 'Overview', link: '/concepts/' },
          { text: 'Velocity and effort', link: '/concepts/velocity-and-effort' },
          { text: 'Calibration and trust', link: '/concepts/calibration-and-trust' },
        ],
      },
      {
        text: 'For coaches',
        items: [
          { text: 'Overview', link: '/coaches/' },
          { text: 'The onboarding model', link: '/coaches/onboarding-model' },
          { text: 'Consent and the data loop', link: '/coaches/consent-and-data-loop' },
          { text: 'Onboard a client', link: '/coaches/onboard-a-client' },
          { text: 'Read a session report', link: '/coaches/read-a-session-report' },
          { text: 'Read the weekly report', link: '/coaches/read-the-weekly-report' },
          { text: 'Import a TrueCoach week', link: '/coaches/import-a-truecoach-week' },
          { text: 'Glossary', link: '/coaches/glossary' },
        ],
      },
      { text: 'Capability reference', collapsed: false, items: referenceSidebar },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/HJewkes/voltras-mcp' }],
  },
});
