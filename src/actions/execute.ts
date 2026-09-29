// Run one allowlisted action, exactly once, and record it (VW-502).
//
// ── The idempotency contract, in full ────────────────────────────────────
//
// The client sends an `actionId` per SUBMIT. A retry of that submit reuses it.
//
//   new id                        -> claim, run the handler, complete, return
//   same id + same input hash     -> return the STORED result, `replayed: true`
//   same id + different input     -> 409 `action_id_reused`, nothing runs
//   same id, row still `pending`  -> `indeterminate`, nothing runs (a pre-VW-659 row)
//
// The input hash is taken over the RAW input, canonicalised: keys sorted and
// explicit `undefined` dropped, so key order cannot split one submission into
// two. It is deliberately NOT taken over the parsed value. `install()` hands
// the capture `schema.shape`, and rebuilding `z.object(shape)` LOSES `.strict()`
// — so a parsed hash would drop an unknown key and let `{phase}` and
// `{phase, sneaky}` collide, replaying the first submission's success for the
// second. Hashing raw can only ever err towards 409, which is the safe side.
//
// ── One transaction, and what a failed handler leaves ──────────────────────
//
// The claim, the handler and the completion run inside one caller-owned
// `store.transaction` (VW-659). Every store call the handler awaits joins it
// as a savepoint, so the three commit together or not at all: a crash before
// the commit leaves no row and no write, and a resubmit of that id runs.
//
// A handler that reports an error has its writes rolled back to a savepoint
// taken before it ran, and the error row is still recorded. So an `error` row
// means nothing changed.
//
// Two submits of one id queue behind each other, and the second finds the
// first's completed row and replays it. Claiming FIRST still matters: the
// primary key refuses a second claim from another process on the same file.
//
// A handler must await only the store. A transaction that spans an event-loop
// turn lets other work on the shared connection run while it is open, and that
// work throws rather than joining; `audited-actions-no-yield.test.ts` pins it.
//
// `pending` is unreachable now. It survives, with the `indeterminate` replay
// below, for rows written before this change: nothing sweeps them to `error`,
// because that would assert an outcome nobody knows.

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { actionEntry, type ActionTier } from './allowlist.js';
import type { CapturedTool, CapturedTools } from './capture-handlers.js';
import type {
  ClaimUiActionInput,
  ClaimUiActionOutcome,
  CompleteUiActionInput,
  StoredUiAction,
  UiActionActor,
  UiActionSurface,
} from '../store/types.js';

/** The store slice the action layer needs. A test fake implements just this. */
export interface ActionStore {
  claimUiAction(input: ClaimUiActionInput): Promise<ClaimUiActionOutcome>;
  completeUiAction(input: CompleteUiActionInput): Promise<StoredUiAction>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * One submitted action. The `actor` is the CALLER's claim about itself, and it
 * is only as trustworthy as the caller: `POST /api/actions` pins it to `user`
 * for that reason (see `readActionRequest` in `dashboard/server.ts`), and an
 * in-process caller stamps its own.
 */
export interface ActionRequest {
  name: string;
  actionId: string;
  actor: UiActionActor;
  surface: UiActionSurface;
  /**
   * Which display sent it (VW-521). Optional, and absent is the common case. A LABEL
   * beside `surface`: nothing branches on it, and it is out of the input hash for the
   * same reason `surface` is — it says who submitted, not what was submitted.
   */
  deviceId?: string | undefined;
  flowId?: string | undefined;
  flowStep?: string | undefined;
  input: unknown;
}

export interface ActionOutcome {
  status: number;
  body: {
    ok: boolean;
    action?: string;
    tier?: ActionTier;
    actionId?: string;
    /** True when the stored result was returned without running anything. */
    replayed?: boolean;
    result?: unknown;
    error?: string;
    message?: string;
  };
}

export interface ExecuteActionDeps {
  store: ActionStore;
  tools: CapturedTools;
  now: () => Date;
}

/** Run an action through the full claim / execute / complete path. */
export async function executeAction(
  request: ActionRequest,
  deps: ExecuteActionDeps,
): Promise<ActionOutcome> {
  const entry = actionEntry(request.name);
  // 403 rather than 404 for an unknown name: a caller probing the layer learns
  // nothing about which names exist, and "not allowed" covers both cases.
  if (entry === undefined) {
    return refusal(403, 'action_not_allowed', `${request.name} is not an allowed action`);
  }
  const tool = deps.tools.get(entry.tool);
  if (tool === undefined) {
    return refusal(500, 'action_unavailable', `${entry.tool} was not captured at boot`);
  }
  // A weaker parse than the handler's, and only an early rejection: it stops an
  // obviously malformed submission from consuming an action id. The handler
  // parses again with the real schema, and that parse is the authority.
  const parsed = parseInput(tool.paramsShape, request.input);
  if (!parsed.ok) {
    return refusal(400, 'invalid_input', parsed.message);
  }
  return executeAudited(
    {
      actionName: request.name,
      actionId: request.actionId,
      actor: request.actor,
      surface: request.surface,
      ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
      ...(request.flowId === undefined ? {} : { flowId: request.flowId }),
      ...(request.flowStep === undefined ? {} : { flowStep: request.flowStep }),
      inputHash: hashInput(request.input),
      tier: entry.tier,
      run: () => runHandler(tool.handler, request.input),
    },
    deps,
  );
}

/** One audited write: what to record, and what to run once the id is claimed. */
export interface AuditedWrite {
  actionName: string;
  actionId: string;
  actor: UiActionActor;
  surface: UiActionSurface;
  deviceId?: string | undefined;
  flowId?: string | undefined;
  flowStep?: string | undefined;
  inputHash: string;
  tier?: ActionTier | undefined;
  /** Runs only after the id is claimed, so it can never run twice for one id. */
  run: () => Promise<HandlerOutcome>;
}

/**
 * Claim the id, run the work, record the result, as one transaction. Shared by the tool actions
 * and by the six plan-builder routes, so both gain the same audit row, the
 * same actor stamp and the same replay behaviour without the plan routes
 * having to pretend a `plan-api.ts` call is an MCP tool.
 */
export async function executeAudited(
  write: AuditedWrite,
  deps: ExecuteActionDeps,
): Promise<ActionOutcome> {
  return deps.store.transaction(() => claimRunComplete(write, deps));
}

async function claimRunComplete(
  write: AuditedWrite,
  deps: ExecuteActionDeps,
): Promise<ActionOutcome> {
  const claim = await deps.store.claimUiAction({
    actionId: write.actionId,
    actionName: write.actionName,
    actor: write.actor,
    surface: write.surface,
    ...(write.deviceId === undefined ? {} : { deviceId: write.deviceId }),
    ...(write.flowId === undefined ? {} : { flowId: write.flowId }),
    ...(write.flowStep === undefined ? {} : { flowStep: write.flowStep }),
    inputHash: write.inputHash,
    createdAt: deps.now().toISOString(),
  });
  if (claim.kind === 'taken') {
    return replayOutcome(claim.existing, write.inputHash, write.tier);
  }
  const outcome = await runKeepingOnlySuccess(write.run, deps.store);
  await deps.store.completeUiAction({
    actionId: write.actionId,
    resultStatus: outcome.ok ? 'ok' : 'error',
    ...(outcome.code === undefined ? {} : { resultCode: outcome.code }),
    result: outcome.result,
    completedAt: deps.now().toISOString(),
  });
  return {
    status: outcome.ok ? (outcome.okStatus ?? 200) : (outcome.errorStatus ?? 400),
    body: {
      ok: outcome.ok,
      action: write.actionName,
      ...(write.tier === undefined ? {} : { tier: write.tier }),
      actionId: write.actionId,
      replayed: false,
      result: outcome.result,
      ...(outcome.code === undefined ? {} : { error: outcome.code }),
    },
  };
}

/** Carries a non-ok outcome out of its savepoint, so the throw rolls the handler back. */
class DiscardedOutcome extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super('the handler reported an error; its writes are rolled back');
  }
}

/** Run the handler in a nested transaction that keeps its writes only when it reports ok. */
async function runKeepingOnlySuccess(
  run: AuditedWrite['run'],
  store: ActionStore,
): Promise<HandlerOutcome> {
  try {
    return await store.transaction(async () => {
      const outcome = await run();
      if (!outcome.ok) throw new DiscardedOutcome(outcome);
      return outcome;
    });
  } catch (err) {
    if (err instanceof DiscardedOutcome) return err.outcome;
    throw err;
  }
}

/** What a second submission of an id that already exists gets back. */
function replayOutcome(
  existing: StoredUiAction,
  inputHash: string,
  tier: ActionTier | undefined,
): ActionOutcome {
  if (existing.inputHash !== inputHash) {
    return refusal(
      409,
      'action_id_reused',
      'that action id was already used for a different request; use a new id',
    );
  }
  if (existing.resultStatus === 'pending') {
    return {
      status: 409,
      body: {
        ok: false,
        action: existing.actionName,
        actionId: existing.actionId,
        error: 'indeterminate',
        message:
          'this action was claimed but never completed, so whether it took effect is unknown. ' +
          'Read the current state; do not resubmit under a new id.',
      },
    };
  }
  return {
    status: existing.resultStatus === 'ok' ? 200 : 400,
    body: {
      ok: existing.resultStatus === 'ok',
      action: existing.actionName,
      ...(tier === undefined ? {} : { tier }),
      actionId: existing.actionId,
      replayed: true,
      result: existing.result,
      ...(existing.resultCode === undefined ? {} : { error: existing.resultCode }),
    },
  };
}

/** What one run produced. The status overrides let a 201 stay a 201. */
export interface HandlerOutcome {
  ok: boolean;
  code?: string;
  result: unknown;
  okStatus?: number;
  errorStatus?: number;
}

/**
 * Call the tool's own handler and read its `ToolResult`. Every handler is
 * `wrapHandler`-wrapped, so it returns a structured error rather than throwing
 * — but a throw is still recorded rather than escaping into the HTTP layer,
 * because an escaping throw would roll back the claim and leave no record.
 */
async function runHandler(
  handler: CapturedTool['handler'],
  input: unknown,
): Promise<HandlerOutcome> {
  let raw: Awaited<ReturnType<CapturedTool['handler']>>;
  try {
    raw = await handler(input);
  } catch (err) {
    return { ok: false, code: 'HANDLER_THREW', result: { message: (err as Error).message } };
  }
  const payload = toolResultPayload(raw);
  if (raw.isError !== true) return { ok: true, result: payload };
  // `errorResult` puts `{ code, message }` straight in the text block and sets
  // `isError`. The code is the tool's own vocabulary and is recorded as-is, so
  // the audit row says GOAL_TARGET_FIXED rather than a status this layer chose.
  const code = (payload as { code?: string } | null)?.code;
  return { ok: false, code: typeof code === 'string' ? code : 'TOOL_ERROR', result: payload };
}

/** A `ToolResult` carries its JSON as the text of its first content block. */
function toolResultPayload(raw: { content?: { text?: string }[] }): unknown {
  const text = Array.isArray(raw.content) ? raw.content[0]?.text : undefined;
  if (typeof text !== 'string') return raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

type ParseOutcome = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Parse with the tool's schema rebuilt from the shape `install()` handed over.
 * Rebuilding loses any wrapper the original carried — `.strict()` above all —
 * so this admits inputs the handler will refuse. That is why it is an early
 * rejection only, and why the hash does not use its output.
 */
function parseInput(shape: Record<string, unknown>, input: unknown): ParseOutcome {
  const parsed = z.object(shape as z.ZodRawShape).safeParse(input ?? {});
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: parsed.error.message };
}

/** sha256 over a key-sorted JSON rendering, so key order cannot change the hash.
 *
 * Every key the client sent is hashed, including one the tool would reject: two
 * submissions that differ at all must not share a hash, or one would replay the
 * other's result. */
export function hashInput(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function refusal(status: number, error: string, message: string): ActionOutcome {
  return { status, body: { ok: false, error, message } };
}
