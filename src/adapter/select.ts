// Adapter selection: pick the real BLE-backed VoltraManager or the
// in-process MockBLEAdapter-backed manager (`forMock()`) once at startup
// based on Config.adapter (R7).
//
// On Node we use `forNodeNoble()` (Phase 1, @stoprocent/noble backend).
// The legacy `forNode()` (webbluetooth/SimpleBLE) shares one C++ adapter
// across `Bluetooth` instances, which causes bilateral cross-talk when
// more than one device is connected. Hardware-validated 2026-05-08:
// captures at voltra-private/captures/sessions/2026-05-08T21-21-10/.

import { VoltraManager } from '@voltras/node-sdk';
import type { Config } from '../config.js';

export function selectAdapter(config: Config): VoltraManager {
  return config.adapter === 'mock' ? VoltraManager.forMock() : VoltraManager.forNodeNoble();
}
