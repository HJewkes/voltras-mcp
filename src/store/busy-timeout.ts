/**
 * How long a connection waits on another connection's lock before SQLITE_BUSY.
 * Five seconds outlasts a normal write transaction here (milliseconds) by orders
 * of magnitude, yet stays under the MCP client's tool-call patience.
 */
export const BUSY_TIMEOUT_MS = 5000;
