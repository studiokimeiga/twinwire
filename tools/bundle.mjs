// Browser bundles: dist/browser/twinwire.js (window.Twinwire) and an ESM twin, both for Safari 15+ and every evergreen browser.
import { build } from 'esbuild';
const common = { entryPoints: ['src/browser.ts'], bundle: true, target: ['es2020', 'safari15'], legalComments: 'none', logLevel: 'warning' };
await build({ ...common, format: 'iife', globalName: 'Twinwire', outfile: 'dist/browser/twinwire.js', sourcemap: true });
await build({ ...common, format: 'iife', globalName: 'Twinwire', outfile: 'dist/browser/twinwire.min.js', minify: true });
await build({ ...common, format: 'esm', outfile: 'dist/browser/twinwire.mjs', sourcemap: true });
