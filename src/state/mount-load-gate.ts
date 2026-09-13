// Gate a mode-driven anchor load against the configured mount pull-out
// rating (VW-274).
//
// No wall/rack anchor rating is published by Beyond Power for any mount, and
// isometric mode alone can put ~2x the nominal 200 lb working ceiling on a
// single anchor (400 lb per unit measuring peak force), while eccentric
// overload is "configurable up to unlimited" — so the anchor, not the cable
// or the motor, is the unbounded risk. `VMCP_MOUNT_RATING_LBS` (`config.ts`)
// is the caller's own measured/published rating; UNSET means UNKNOWN, never
// "no limit", so the unconfigured case is a warning, not a green light.

/** What checking a mode-driven peak against the configured rating decided. */
export interface MountLoadVerdict {
  /** True when the peak exceeds a CONFIGURED rating. The caller must refuse. */
  refused: boolean;
  /** Present only when `refused`; names the mode-driven peak, not a displayed weight. */
  refusalMessage?: string;
  /** Present only when no rating is configured — never alongside a refusal. */
  warning?: string;
}

const UNCONFIGURED_WARNING =
  'No VMCP_MOUNT_RATING_LBS is configured, so the anchor load envelope is UNKNOWN — ' +
  'this is a warning, not a guarantee the mount can hold the load. Configure ' +
  'VMCP_MOUNT_RATING_LBS once the mount maker or Beyond Power confirms a pull-out rating.';

/**
 * Check one mode-driven peak load (never the displayed/commanded weight)
 * against the configured mount rating.
 *
 * `peakDescription` names WHAT is peaking and why — "isometric max force, up
 * to 400 lb per unit" or "eccentric overload peak (weightLbs + overloadLbs)"
 * — so a refusal or warning is self-explanatory without the caller looking
 * anything up.
 */
export function checkMountLoad(
  mountRatingLbs: number | undefined,
  peakLbs: number,
  peakDescription: string,
): MountLoadVerdict {
  if (mountRatingLbs === undefined) {
    return { refused: false, warning: UNCONFIGURED_WARNING };
  }
  if (peakLbs > mountRatingLbs) {
    return {
      refused: true,
      refusalMessage:
        `Refused: ${peakDescription} of ${peakLbs} lb exceeds the configured mount rating ` +
        `of ${mountRatingLbs} lb (VMCP_MOUNT_RATING_LBS). Lower the requested load, use a ` +
        'mount rated for it, or raise VMCP_MOUNT_RATING_LBS if it was set too conservatively.',
    };
  }
  return { refused: false };
}

/** Isometric mode's peak measurable force on a single unit (VW-274). */
export const ISOMETRIC_MAX_PEAK_LBS_PER_UNIT = 400;
