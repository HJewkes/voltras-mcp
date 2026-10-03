// Kept free of imports so any layer, the store included, can throw one
// without pulling in the SDK.

/**
 * Base for the errors this server throws on purpose: their message is worded
 * for the client and may reach it as is. Any other Error is treated as coming
 * from the SDK or BLE stack and is replaced by fixed wording (VW-878).
 */
export class UserFacingError extends Error {}
