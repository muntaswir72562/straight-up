// Copy the Next.js standalone server into desktop/resources/server, with the
// static assets and public/ it needs (as the Dockerfile does).
//
// Run after `next build` in the repo root:  node desktop/scripts/prepare-server.js
//
// The standalone output currently traces the whole project (dynamic fs paths
// in some routes), so only what the server needs at runtime is copied:
// server.js, package.json, node_modules/ and .next/.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const standalone = path.join(root, '.next', 'standalone');
const out = path.join(__dirname, '..', 'resources', 'server');

const KEEP = new Set(['server.js', 'package.json', 'node_modules', '.next']);
const SKIP_IN_NEXT = new Set(['cache', 'dev']);

if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error(`No standalone build at ${standalone}. Run "npm run build" in the repo root first.`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const name of fs.readdirSync(standalone)) {
  if (!KEEP.has(name)) continue;
  fs.cpSync(path.join(standalone, name), path.join(out, name), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(path.join(standalone, '.next'), src).split(path.sep);
      return !(rel[0] !== '..' && SKIP_IN_NEXT.has(rel[0]));
    },
  });
}
fs.cpSync(path.join(root, '.next', 'static'), path.join(out, '.next', 'static'), { recursive: true });
if (fs.existsSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
}

let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size;
  }
};
walk(out);
console.log(`server prepared in ${out} (${(bytes / 1e6).toFixed(1)} MB)`);
