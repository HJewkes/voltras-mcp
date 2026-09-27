import type { DefaultTheme } from 'vitepress';

import { statusLabel } from './theme/status';

type LocalSearchOptions = DefaultTheme.LocalSearchOptions;
type RenderHook = NonNullable<LocalSearchOptions['_render']>;

/** Prefixes a badged page's H1 in the search index, so a result never implies availability. */
const renderWithStatus: RenderHook = (src, env, md) => {
  const html = md.render(src, env);
  if (env.frontmatter?.search === false) return '';
  const label = statusLabel(env.frontmatter?.status);
  if (label === undefined) return html;
  return html.replace(/<h1([^>]*)>/, `<h1$1>${label.searchPrefix}: `);
};

export const statusSearchOptions: LocalSearchOptions = { _render: renderWithStatus };
