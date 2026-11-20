#!/usr/bin/env node
import { nodeFloorProblem } from './node-floor.js';

const problem = nodeFloorProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}

// Dynamic so the check above runs before the import graph reaches node:sqlite.
import('./server.js')
  .then((m) => m.runServer())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
