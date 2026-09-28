// Runs the v2 integration project with the invariant sweep enabled
// (tests/setup/invariant-sweep.ts, spec 010 T016). Cross-platform env setting
// without a cross-env dependency.
const { spawnSync } = require('child_process');
const args = ['vitest', 'run', '--project', 'v2', ...process.argv.slice(2)];
const r = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, INVARIANT_SWEEP: '1' },
});
process.exit(r.status ?? 1);
