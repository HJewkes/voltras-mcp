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
      { text: 'Get started', link: '/start/' },
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
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/start/' },
          { text: 'Install', link: '/start/install' },
          { text: 'Your first session', link: '/start/first-session' },
          { text: 'Try it without a device', link: '/start/try-without-a-device' },
          { text: 'Launch options', link: '/start/launch-options' },
        ],
      },
      {
        text: 'The dashboard',
        items: [
          { text: 'Overview', link: '/guides/dashboard' },
          { text: 'Set it up and open it', link: '/guides/dashboard-setup' },
          { text: 'Live workout tour', link: '/guides/dashboard-tour' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Overview', link: '/guides/' },
          { text: 'Running a planned session', link: '/guides/planned-session' },
          { text: 'Bilateral work', link: '/guides/bilateral' },
          { text: 'Isometric assessment', link: '/guides/isometric' },
          { text: 'Troubleshooting', link: '/guides/troubleshooting' },
        ],
      },
      {
        text: 'Docs',
        items: [
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
          { text: 'Fatigue and pacing', link: '/concepts/fatigue-and-pacing' },
          { text: 'Technique signals', link: '/concepts/technique-signals' },
          { text: 'How coaching works', link: '/concepts/how-coaching-works' },
          { text: 'Privacy and local data', link: '/concepts/privacy-and-local-data' },
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
      {
        text: 'Coming soon',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/coming-soon/' },
          { text: 'Body map', link: '/coming-soon/body-map' },
          { text: 'Goals page', link: '/coming-soon/goals-page' },
          { text: 'Effort readout', link: '/coming-soon/effort-readout' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/HJewkes/voltras-mcp' }],
  },
});
