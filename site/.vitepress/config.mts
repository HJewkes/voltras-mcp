import { defineConfig } from 'vitepress';

// GitHub Pages serves this as a project site under /voltras-mcp/, not the
// repo root, so every asset/link needs that prefix baked in.
export default defineConfig({
  title: 'voltras-mcp',
  description:
    'An MCP server that turns a Voltra digital-resistance trainer into something Claude can drive.',
  base: '/voltras-mcp/',
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Install and run', link: '/install-and-run' },
      { text: 'Capability reference', link: '/capability-reference' },
      { text: 'Guides', link: '/guides/' },
      { text: 'Planned', link: '/planned' },
      { text: 'Changelog', link: '/changelog' },
    ],

    sidebar: [
      {
        text: 'Docs',
        items: [
          { text: 'Install and run', link: '/install-and-run' },
          { text: 'Capability reference', link: '/capability-reference' },
          { text: 'Guides', link: '/guides/' },
          { text: 'Planned', link: '/planned' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/HJewkes/voltras-mcp' }],
  },
});
