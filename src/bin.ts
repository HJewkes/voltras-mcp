#!/usr/bin/env node
import('./server.js')
  .then((m) => m.runServer())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
