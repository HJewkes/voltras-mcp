// Thresholds for the set-level risk score (VW-152 section 3). Every value is a PLACEHOLDER until the owner rules (VW-616).

export interface PlaceholderConstant<T> {
  readonly value: T;
  readonly status: 'PLACEHOLDER';
  readonly note: string;
}

export interface SetRiskThresholds {
  readonly intensityModerate: number;
  readonly intensityHigh: number;
  readonly lateSetFromIndex: number;
  readonly loadModerateLbs: number | null;
  readonly loadHighLbs: number | null;
  readonly greenMax: number;
  readonly amberMax: number;
}

export type SetRiskPolicy = {
  readonly [K in keyof SetRiskThresholds]: PlaceholderConstant<SetRiskThresholds[K]>;
};

export const SET_RISK_POLICY: SetRiskPolicy = {
  intensityModerate: {
    value: 0.7,
    status: 'PLACEHOLDER',
    note: 'Relative intensity where the intensity factor reaches level 1. Borrowed from the lower bound of the Jukic 2024 velocity band; not a risk band.',
  },
  intensityHigh: {
    value: 0.85,
    status: 'PLACEHOLDER',
    note: 'Relative intensity where the intensity factor reaches level 2. No source; the owner sets it.',
  },
  lateSetFromIndex: {
    value: 4,
    status: 'PLACEHOLDER',
    note: 'Set index in the exercise from which the fatigue factor adds a level. Reuses the adaptive-rest late-pair engineering default.',
  },
  loadModerateLbs: {
    value: null,
    status: 'PLACEHOLDER',
    note: 'Per-unit load where the load factor reaches level 1. No owner value yet, so the load factor reads its strictest level.',
  },
  loadHighLbs: {
    value: null,
    status: 'PLACEHOLDER',
    note: 'Per-unit load where the load factor reaches level 2. Should follow the mount rating once that is configured (VW-274).',
  },
  greenMax: {
    value: 2,
    status: 'PLACEHOLDER',
    note: 'Highest point total that reads green. No source; the owner sets it.',
  },
  amberMax: {
    value: 4,
    status: 'PLACEHOLDER',
    note: 'Highest point total that reads amber. No source; the owner sets it.',
  },
};

export const DEFAULT_SET_RISK_THRESHOLDS: SetRiskThresholds = {
  intensityModerate: SET_RISK_POLICY.intensityModerate.value,
  intensityHigh: SET_RISK_POLICY.intensityHigh.value,
  lateSetFromIndex: SET_RISK_POLICY.lateSetFromIndex.value,
  loadModerateLbs: SET_RISK_POLICY.loadModerateLbs.value,
  loadHighLbs: SET_RISK_POLICY.loadHighLbs.value,
  greenMax: SET_RISK_POLICY.greenMax.value,
  amberMax: SET_RISK_POLICY.amberMax.value,
};
