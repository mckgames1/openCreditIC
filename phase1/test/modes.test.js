'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('demo blocks legacy routes and legacy mode retains its route', async () => {
  const root = path.resolve(__dirname, '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencredit-modes-'));
  fs.copyFileSync(path.join(root, 'card-server.js'), path.join(dir, 'card-server.js'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ arcade_name: 'Test' }));
  async function run(env, port, paths) {
    const child = spawn(process.execPath, [path.join(env.OPENCREDIT_MODE ? root : dir, 'card-server.js')], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
        child.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
        child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)); });
      });
      for (const [route, expected] of paths) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(response.status, expected, route);
      }
    } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  await run({ OPENCREDIT_MODE: 'demo', PHASE1_PORT: '18787', PHASE1_DB_PATH: path.join(dir, 'demo.sqlite') }, 18787, [['/phase1/', 200], ['/dispense/DEVICE/CARD', 404], ['/deposit/user/USER/1', 404], ['/callback/DEVICE/CARD', 404]]);
  await run({ OPENCREDIT_MODE: '' }, 1777, [['/get/machine/UNKNOWN', 404]]);
});
