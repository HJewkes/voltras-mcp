// The page-status vocabulary, shared by the theme components and the search index.
export type PageStatus = 'available' | 'experimental' | 'coming-soon';

export interface StatusLabel {
  /** Badge text; says the status in words so colour never carries it alone. */
  text: string;
  /** Prefix for the page's title in local search results. */
  searchPrefix: string;
  badgeType: 'warning' | 'info';
}

const LABELS: Record<Exclude<PageStatus, 'available'>, StatusLabel> = {
  experimental: { text: 'Experimental', searchPrefix: 'Experimental', badgeType: 'warning' },
  'coming-soon': {
    text: 'Coming soon: not yet usable',
    searchPrefix: 'Coming soon',
    badgeType: 'info',
  },
};

/** The label for a badged status, or undefined for `available` and anything unknown. */
export function statusLabel(status: unknown): StatusLabel | undefined {
  if (status === 'experimental' || status === 'coming-soon') return LABELS[status];
  return undefined;
}

/** YAML reads `2026-09-27` as a date, which reaches the client as an ISO timestamp. */
export function formatVerifiedDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).slice(0, 10);
}
