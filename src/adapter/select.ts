// Adapter selection: pick the real `noble`-backed VoltraManager
// (`forNode()`) or the in-process MockBLEAdapter-backed manager
// (`forMock()`) once at startup based on Config.adapter (R7).

import { VoltraManager } from '@voltras/node-sdk';
import type { Config } from '../config.js';

export function selectAdapter(config: Config): VoltraManager {
  return config.adapter === 'mock' ? VoltraManager.forMock() : VoltraManager.forNode();
}
