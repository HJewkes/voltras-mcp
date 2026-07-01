// Schema-bounds tests for the `device.*` setter schemas (VMCP-schema-bounds).
//
// These assert that the zod layer's numeric bounds mirror the SDK's discrete
// valid sets, so an off-range / off-step value is rejected AT THE TOOL BOUNDARY
// (INVALID_INPUT via `safeParse`) rather than surfacing later as an SDK
// `InvalidSettingError` on the BLE write path. Ground truth for each range comes
// from the SDK's `getAvailable*` tables (verified on-device 2026-05-06):
//   band max force            → every integer 15..70
//   isokinetic target speed   → 0..2000 step 10
//   isokinetic ecc speed limit→ 0..2000 step 10 (0 = auto)

import { describe, expect, it } from 'vitest';

import {
  DeviceConfigureIsokineticInput,
  DeviceSetBandMaxForceInput,
  DeviceSetIsokineticEccSpeedLimitInput,
  DeviceSetIsokineticTargetSpeedInput,
} from '../device.js';

describe('DeviceSetBandMaxForceInput bounds (SDK valid set 15..70)', () => {
  it('accepts the documented 15..70 endpoints', () => {
    expect(DeviceSetBandMaxForceInput.safeParse({ lbs: 15 }).success).toBe(true);
    expect(DeviceSetBandMaxForceInput.safeParse({ lbs: 70 }).success).toBe(true);
  });

  it('rejects a below-range value the SDK does not accept (14)', () => {
    expect(DeviceSetBandMaxForceInput.safeParse({ lbs: 14 }).success).toBe(false);
  });

  it('rejects a previously-passing in-between value (5) now that bounds match the SDK', () => {
    // Before this fix the schema accepted 0..100, so 5 slipped through to the
    // BLE write; it must now be rejected at the schema layer.
    expect(DeviceSetBandMaxForceInput.safeParse({ lbs: 5 }).success).toBe(false);
  });

  it('rejects an above-range value (71) formerly allowed by the 0..100 bound', () => {
    expect(DeviceSetBandMaxForceInput.safeParse({ lbs: 71 }).success).toBe(false);
  });
});

describe('DeviceSetIsokineticTargetSpeedInput bounds (0..2000 step 10)', () => {
  it('accepts on-step values including the 0 and 2000 endpoints', () => {
    expect(DeviceSetIsokineticTargetSpeedInput.safeParse({ mmPerSec: 0 }).success).toBe(true);
    expect(DeviceSetIsokineticTargetSpeedInput.safeParse({ mmPerSec: 1500 }).success).toBe(true);
    expect(DeviceSetIsokineticTargetSpeedInput.safeParse({ mmPerSec: 2000 }).success).toBe(true);
  });

  it('rejects an off-step value the SDK cannot resolve (1505)', () => {
    expect(DeviceSetIsokineticTargetSpeedInput.safeParse({ mmPerSec: 1505 }).success).toBe(false);
  });

  it('rejects an above-range value (2010)', () => {
    expect(DeviceSetIsokineticTargetSpeedInput.safeParse({ mmPerSec: 2010 }).success).toBe(false);
  });
});

describe('DeviceSetIsokineticEccSpeedLimitInput bounds (0..2000 step 10, 0=auto)', () => {
  it('accepts 0 (auto) and on-step values', () => {
    expect(DeviceSetIsokineticEccSpeedLimitInput.safeParse({ mmPerSec: 0 }).success).toBe(true);
    expect(DeviceSetIsokineticEccSpeedLimitInput.safeParse({ mmPerSec: 800 }).success).toBe(true);
  });

  it('rejects an off-step value (1505)', () => {
    expect(DeviceSetIsokineticEccSpeedLimitInput.safeParse({ mmPerSec: 1505 }).success).toBe(false);
  });
});

describe('DeviceConfigureIsokineticInput speed-field steps', () => {
  const base = { eccMode: 'isokinetic' as const };

  it('accepts on-step required and optional speeds', () => {
    expect(
      DeviceConfigureIsokineticInput.safeParse({
        ...base,
        targetSpeedMmPerSec: 800,
        eccSpeedLimitMmPerSec: 600,
      }).success,
    ).toBe(true);
  });

  it('rejects an off-step required targetSpeedMmPerSec (805)', () => {
    expect(
      DeviceConfigureIsokineticInput.safeParse({ ...base, targetSpeedMmPerSec: 805 }).success,
    ).toBe(false);
  });

  it('rejects an off-step optional eccSpeedLimitMmPerSec (605)', () => {
    expect(
      DeviceConfigureIsokineticInput.safeParse({
        ...base,
        targetSpeedMmPerSec: 800,
        eccSpeedLimitMmPerSec: 605,
      }).success,
    ).toBe(false);
  });
});
