#!/usr/bin/env node
/**
 * Executable entry. It must set the React build before anything imports Ink.
 *
 * A static `import` is evaluated before this file's body runs, so importing the CLI
 * directly would let `react-reconciler` resolve to its development build and emit a
 * `performance.measure()` entry for every render. Node's performance timeline holds
 * those entries for the life of the process and never trims them, which grew the heap
 * by roughly 1.2 KB per render until the process was restarted. The dynamic import
 * below is therefore load-bearing: `NODE_ENV` has to be set first.
 *
 * Set `DSHT_REACT_DEV=1` to keep the development build for React warnings and
 * DevTools performance tracks.
 */
if ((process.env.DSHT_REACT_DEV ?? '') === '') process.env.NODE_ENV ??= 'production';

await import('./dsht.js');
