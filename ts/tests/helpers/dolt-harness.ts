/**
 * Throwaway `dolt sql-server` for persistence tests (spec 010, T003).
 *
 * Each call to startDolt() gets its own temp data dir, its own free port and
 * its own DOLT_ROOT_PATH (so the developer's global Dolt identity/config is
 * never read or written). The server is killed and the dir removed on stop().
 * restart() kills and relaunches on the same dir: used to prove that an
 * uncommitted working set survives a server restart (SC-003).
 *
 * A missing `dolt` binary fails loudly — persistence tests never skip.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import mysql from 'mysql2/promise';

export interface DoltHarness {
  host: string;
  port: number;
  dataDir: string;
  /** Environment to pass to any `dolt` CLI invocation against this harness. */
  env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** A fresh root connection (no default database). Caller closes it. */
  connect(database?: string): Promise<mysql.Connection>;
}

const READY_TIMEOUT_MS = 20_000;

function assertDoltInstalled(): void {
  const r = spawnSync('dolt', ['version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    throw new Error(
      'dolt binary not found on PATH — persistence tests require Dolt ' +
        '(https://github.com/dolthub/dolt/releases). They are never skipped.',
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(host: string, port: number, proc: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`dolt sql-server exited early (code ${proc.exitCode}): ${stderr().slice(-2000)}`);
    }
    try {
      const c = await mysql.createConnection({ host, port, user: 'root', password: '' });
      await c.end();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`dolt sql-server not ready after ${READY_TIMEOUT_MS} ms: ${String(lastErr)}\n${stderr().slice(-2000)}`);
}

export async function startDolt(): Promise<DoltHarness> {
  assertDoltInstalled();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-dolt-'));
  const dataDir = path.join(root, 'data');
  const doltRoot = path.join(root, 'dolt-root');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(doltRoot, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, DOLT_ROOT_PATH: doltRoot };
  for (const [k, v] of [
    ['user.name', 'mcp-cad test'],
    ['user.email', 'test@mcp-cad.local'],
  ]) {
    spawnSync('dolt', ['config', '--global', '--add', k, v], { env, shell: process.platform === 'win32' });
  }

  const host = '127.0.0.1';
  const port = await freePort();
  let proc: ChildProcess;
  let errBuf = '';

  const launch = async (): Promise<void> => {
    errBuf = '';
    proc = spawn('dolt', ['sql-server', '--host', host, '--port', String(port), '--data-dir', dataDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    proc.stderr?.on('data', (d) => {
      errBuf += String(d);
    });
    proc.stdout?.on('data', (d) => {
      errBuf += String(d);
    });
    await waitReady(host, port, proc, () => errBuf);
  };

  const kill = async (): Promise<void> => {
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.kill();
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5_000);
    });
  };

  await launch();

  return {
    host,
    port,
    dataDir,
    env,
    connect: (database?: string) =>
      mysql.createConnection({ host, port, user: 'root', password: '', database, multipleStatements: true }),
    restart: async () => {
      await kill();
      await launch();
    },
    stop: async () => {
      await kill();
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can hold file handles briefly after process exit; a leftover
        // temp dir is harmless and the OS temp cleaner reclaims it.
      }
    },
  };
}

/**
 * Writes a temporary storage-accounts file with a single `test` account
 * pointing at the harness and sets MCPCAD_ACCOUNTS to it. Returns a restore
 * function.
 */
export function withTestAccount(h: DoltHarness, opts: { prefix?: string } = {}): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-cfg-'));
  const cfgPath = path.join(dir, 'storage-accounts.yaml');
  fs.writeFileSync(
    cfgPath,
    [
      'storage_accounts:',
      '  - id: test',
      '    driver: dolt',
      `    host: ${h.host}`,
      `    port: ${h.port}`,
      '    user: root',
      '    secret_ref: null',
      `    database_prefix: ${opts.prefix ?? 't_'}`,
      '',
    ].join('\n'),
  );
  const prev = process.env['MCPCAD_ACCOUNTS'];
  process.env['MCPCAD_ACCOUNTS'] = cfgPath;
  return () => {
    if (prev === undefined) delete process.env['MCPCAD_ACCOUNTS'];
    else process.env['MCPCAD_ACCOUNTS'] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
