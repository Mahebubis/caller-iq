#!/usr/bin/env node
/*
 * npm run dev — starts the React Native bundler (Metro) and the WhatsApp bridge together, with
 * their output side by side ([metro] / [bridge]). Ctrl+C stops both. The bridge's dependencies
 * are installed on the first run. Settings for the bridge (BRIDGE_KEY, PORT, CHROME_PATH…) come
 * from the environment, or from whatsapp-bridge/.env (KEY=value lines).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bridgeDir = path.join(root, 'whatsapp-bridge');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';

const env = { ...process.env };
const envFile = path.join(bridgeDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!fs.existsSync(path.join(bridgeDir, 'node_modules'))) {
  console.log('[dev] Installing the WhatsApp bridge (first run, downloads Chrome for it)…');
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: bridgeDir, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { console.error('[dev] npm install failed in whatsapp-bridge'); process.exit(1); }
}

const children = [];
const run = (name, cmd, args, cwd, color) => {
  const child = spawn(cmd, args, { cwd, env, shell: isWin });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach((l) => out.write(tag + l + '\n'));
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${tag}stopped (${code})`);
    stopAll(code || 0);
  });
  children.push(child);
};

let stopping = false;
const stopAll = (code) => {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => { try { c.kill(); } catch (_) {} });
  setTimeout(() => process.exit(code), 500);
};
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

run('metro', npx, ['react-native', 'start'], root, '36');
run('bridge', 'node', ['server.js'], bridgeDir, '32');
