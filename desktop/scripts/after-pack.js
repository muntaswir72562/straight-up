// electron-builder afterPack hook: copy the Next.js server's node_modules.
// electron-builder never copies folders named node_modules from
// extraResources (whatever the filter), so the standalone server would start
// without `next`. This runs after the app folder is laid out and before the
// NSIS installer is built.
'use strict';

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, '..', 'resources', 'server', 'node_modules');
  const dst = path.join(context.appOutDir, 'resources', 'server', 'node_modules');
  if (!fs.existsSync(src)) throw new Error(`missing ${src}: run "npm run prepare-server" first`);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  if (!fs.existsSync(path.join(dst, 'next', 'package.json'))) throw new Error('next not copied into the server');
  console.log(`  • afterPack: copied server node_modules -> ${dst}`);
};
