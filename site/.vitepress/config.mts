import { defineConfig } from 'vitepress';
// Emitted by `npm run docs:reference` alongside the reference pages themselves,
// so a new tool namespace never needs a hand edit here.
import referenceSidebar from './reference-sidebar.json';

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
    search: { provider: 'local' },
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
      { text: 'Planned', link: '/planned' },
      { text: 'Changelog', link: '/changelog' },
    ],

    sidebar: [
      {
        text: 'Docs',
        items: [
          { text: 'Install and run', link: '/install-and-run' },
          { text: 'Guides', link: '/guides/' },
          { text: 'Planned', link: '/planned' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
      { text: 'Capability reference', collapsed: false, items: referenceSidebar },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/HJewkes/voltras-mcp' }],
  },
});
