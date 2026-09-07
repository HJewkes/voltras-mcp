// Every registered tool must carry a description (VW-153).
//
// A tool with no `description` reaches the model as a bare name plus a JSON
// schema, so the model has to guess the precondition, the side effect and the
// error codes — which is how ten tools quietly shipped undescribed. tsc cannot
// catch this: `install(...)`'s `description` parameter is optional by design
// (the placeholder keeps whatever it had), so omitting it is a silent no-op.
//
// This walks the canonical name list against a BOOTED mock server rather than
// grepping the source, so a tool whose registration never runs fails here too.
// Mock adapter + throwaway SQLite: no radio, no shared DB.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClientConnection,
  __resetClientIdSequence,
  type ClientConnection,
} from '../client-connection.js';
import { loadConfig } from '../config.js';
import { bootstrapState, type ServerState } from '../state/server-state.js';
import { CORE_TOOL_NAMES } from '../tool-registry.js';

let dbDir: string;
let state: ServerState;
let connection: ClientConnection;
const savedEnv = { ...process.env };

beforeAll(async () => {
  __resetClientIdSequence();
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-descriptions-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'descriptions.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  state = await bootstrapState(loadConfig());
  connection = createClientConnection('client-descriptions');
  connection.activate(state);
});

afterAll(() => {
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

describe('tool descriptions', () => {
  it('registers every core tool name on a booted server', () => {
    const missing = CORE_TOOL_NAMES.filter((name) => !connection.placeholders.has(name));
    expect(missing).toEqual([]);
  });

  it.each(CORE_TOOL_NAMES)('%s has a non-empty description', (name) => {
    const tool = connection.placeholders.get(name);
    expect(tool, `${name} is not registered`).toBeDefined();
    const description = tool?.description;
    expect(
      typeof description === 'string' && description.trim().length > 0,
      `${name} has no description — pass one as the last argument to its install(...) call`,
    ).toBe(true);
  });
});
