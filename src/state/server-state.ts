// Aggregate state container assembled by `bootstrapState()` and threaded into
// every tool/resource registration as a single argument.
//
// Wave 1 ships this file as a typed STUB: the `ServerState` interface is
// final, but `bootstrapState` throws "not yet initialized". Task 09 (Wave 2C)
// rewrites the function body to actually open the SDK adapter, the SQLite
// store, and construct the `LiveState` + `ExerciseService` dependencies.
// The stub exists in Wave 1 so `src/server.ts` can typecheck — `bootstrapState`
// is only invoked at runtime, after Wave 2C lands.
//
// Do NOT remove or change the exported names/shapes; downstream wiring
// (event-bridge, tool registries) imports them by these exact identifiers.

import type { Config } from '../config.js';
import type { VoltraManager, VoltraClient } from '@voltras/node-sdk';
import type { LiveState } from './live-state.js';
import type { SessionStore } from '../store/types.js';
import type { ExerciseService } from '../exercises/exercise-service.js';

export interface ServerState {
  config: Config;
  manager: VoltraManager;
  client: VoltraClient;
  live: LiveState;
  store: SessionStore;
  exercises: ExerciseService;
}

// Stub: Task 09 (Wave 2C) replaces this body with the real implementation.
// Do NOT remove the interface or signature.
export async function bootstrapState(_config: Config): Promise<ServerState> {
  throw new Error('bootstrapState not yet implemented — run after Wave 2C');
}
