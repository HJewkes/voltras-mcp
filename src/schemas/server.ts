// Input schemas for `server.*` tools.
//
// `server.health` is a parameterless diagnostic tool — empty input by design.
// All output fields come from process state (package.json, git, config) and
// are populated at handler time, not validated at schema time.

import { z } from 'zod';

/** Input for `server.health`. Empty by design. */
export const ServerHealthInput = z.object({});
