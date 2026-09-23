// `ui_actions.device_id` carries no CHECK (VW-521): the values are client-chosen, so no
// enumeration could describe them. This predicate is the whole guard, and it is pinned
// here because the cost of it being wrong is an audit row the schema happily stores and no
// later reader can quote.

import { describe, expect, it } from 'vitest';

import { isUiActionDeviceId, UI_ACTION_DEVICE_ID_MAX_LENGTH } from '../ui-action-device-id.js';

describe('isUiActionDeviceId', () => {
  it('admits the shapes a display would actually name itself', () => {
    for (const id of ['wall-garage', 'wall_1', 'kitchen.wall', 'ns:wall-2', 'a', '7']) {
      expect(isUiActionDeviceId(id)).toBe(true);
    }
  });

  it('admits a UUID, which is what a client with no name of its own sends', () => {
    expect(isUiActionDeviceId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('refuses a string nobody could quote back', () => {
    for (const id of ['wall garage', 'wall/garage', 'wall\nspare', '-leading', '', 'wall#1']) {
      expect(isUiActionDeviceId(id)).toBe(false);
    }
  });

  it('refuses anything longer than the bound, and admits the bound itself', () => {
    expect(isUiActionDeviceId('w'.repeat(UI_ACTION_DEVICE_ID_MAX_LENGTH))).toBe(true);
    expect(isUiActionDeviceId('w'.repeat(UI_ACTION_DEVICE_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('refuses a value that is not a string at all', () => {
    for (const value of [7, null, undefined, {}, ['wall-garage']]) {
      expect(isUiActionDeviceId(value)).toBe(false);
    }
  });
});
