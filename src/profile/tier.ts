// The lifter's training tier and how far it is trusted (VW-813). A leaf with no
// imports, so analytics, plan and profile can name a tier without depending on
// `src/tools/tier-signal.ts`, which derives one.

export type Tier = 'beginner' | 'intermediate' | 'advanced';

export type TierConfidence = 'provisional' | 'confident';

export type TierSource = 'default' | 'declared' | 'derived';
