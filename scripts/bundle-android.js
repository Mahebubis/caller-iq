#!/usr/bin/env node
/*
 * npm run bundle:android — builds the JavaScript the APK ships, as Hermes bytecode.
 *
 * The app loads app/src/main/assets/index.android.bundle (getUseDeveloperSupport is false), so this
 * must run before every APK build that should carry JS changes. Bytecode instead of plain JS means
 * Hermes skips parsing and compiling at launch: the dashboard is ready much sooner after the brand
 * intro. The compiler is the one React Native ships for this exact version (sdks/hermesc), so
 * there is nothing extra to install; Hermes recognises bytecode in the same asset file by itself.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'src', 'main', 'assets', 'index.android.bundle');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calliq-bundle-'));
const js = path.join(tmp, 'index.android.bundle.js');
const isWin = process.platform === 'win32';
const hermesc = path.join(root, 'node_modules', 'react-native', 'sdks', 'hermesc',
  isWin ? 'win64-bin' : process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin',
  isWin ? 'hermesc.exe' : 'hermesc');

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { console.error(`[bundle] failed: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
};

try {
  console.log('[bundle] Packing the JavaScript…');
  run(isWin ? 'npx.cmd' : 'npx', ['react-native', 'bundle', '--platform', 'android', '--dev', 'false',
    '--entry-file', 'index.js', '--bundle-output', js, '--assets-dest', path.join(tmp, 'res'), '--max-workers', '2']);
  console.log('[bundle] Compiling to Hermes bytecode…');
  run(hermesc, ['-emit-binary', '-O', '-w', '-out', out, js]);
  const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
  console.log(`[bundle] Done: ${path.relative(root, out)} (${kb(out)} bytecode, from ${kb(js)} of JS)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
