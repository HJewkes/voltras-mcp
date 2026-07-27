// Schemas for the `system.lease_*` tools (VMCP-01.61).

import { z } from 'zod';

export const LeaseStatusInput = z.object({});

export const LeaseAcquireInput = z.object({
  force: z
    .boolean()
    .optional()
    .describe(
      'Take the lease even though another client holds it. When a set is in ' +
        'progress the device is unloaded first — the other session loses ' +
        'control of a live lift, so only force when you know the other ' +
        'session is abandoned.',
    ),
  acceptLoadedDevice: z
    .boolean()
    .optional()
    .describe(
      'Proceed with a forced takeover even when NO connected slot could be ' +
        'unloaded, meaning the cable may still be under load. Only set this ' +
        'when you know the device is unattended.',
    ),
});

export const LeaseReleaseInput = z.object({});
