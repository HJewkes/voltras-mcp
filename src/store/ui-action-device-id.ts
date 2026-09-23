// Which display sent an action (VW-521), and the one predicate that decides whether a
// string belongs in `ui_actions.device_id`.
//
// More than one wall can stand in one house, and `surface` cannot tell them apart: it
// says `wall`, not WHICH wall. The device id is the client's own name for the physical
// display or client instance it runs on — a name it picks once and reuses, opaque to the
// server and meaningful only to whoever reads the trail.
//
// IT IS A LABEL, EXACTLY AS `surface` IS. Nothing may branch on it to decide what a
// request is allowed to do: it is the client's unverifiable assertion, so treating it as
// an authorization input would hand any client the choice of its own permissions.
//
// FREE TEXT IN THE SCHEMA, VALIDATED HERE, the same stance as `learned_rest.context`. The
// values are client-chosen and unbounded in principle, so no CHECK could enumerate them;
// the bound below exists to keep one runaway client from writing an audit row nobody can
// read, not to describe what a display is.

/** Longest device id the audit row accepts. Long enough for a UUID and a short name. */
export const UI_ACTION_DEVICE_ID_MAX_LENGTH = 64;

/**
 * Printable, punctuation-light and free of whitespace, so a device id reads the same in a
 * log line, a query and a URL. Deliberately narrower than "any string": an id nobody can
 * quote is worse for the trail than one a client had to rename.
 */
const DEVICE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Is `value` a device id the audit row will store? The schema cannot answer this. */
export function isUiActionDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= UI_ACTION_DEVICE_ID_MAX_LENGTH &&
    DEVICE_ID_SHAPE.test(value)
  );
}
