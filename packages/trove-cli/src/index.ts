#!/usr/bin/env bun
import { run } from './cli.js';

/**
 * The `trove` binary entry point. Delegates to the testable {@link run} core
 * and translates the returned exit code into a real `process.exit`. Keeping the
 * `process.exit` here (and out of `run`) is what lets the whole command surface
 * be unit-tested in-process.
 *
 * `trove` runs on Bun: the shipped single-binary embeds it, and the npm package's
 * bin uses the Bun shebang (so an `npm`/`bunx` install runs on the user's Bun).
 */
const code = await run({ argv: process.argv.slice(2) });
process.exit(code);
