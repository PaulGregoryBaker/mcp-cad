/**
 * Storage account setup CLI — the MCP server's "account setup" (spec 010,
 * R-014, T009). The ONLY place credentials are entered; they go straight to
 * the OS keyring (or stay in the env/file they're referenced from) and are
 * never written to the accounts file, printed, or sent through MCP.
 *
 *   npm run account -- add <id> --host H [--port 3306] --user U --prefix P
 *                           [--secret-prompt | --secret-env VAR | --secret-file PATH | --no-secret]
 *                           [--tls off|preferred|required]
 *   npm run account -- list
 *   npm run account -- test <id>
 *   npm run account -- remove <id>
 */

import * as readline from 'readline';
import mysql from 'mysql2/promise';
import { Entry } from '@napi-rs/keyring';
import {
  getStorageAccounts,
  resolveAccountsPath,
  writeStorageAccounts,
  StorageAccountSchema,
  type StorageAccount,
} from '../src/config/storage-accounts';
import { connectionOptions, parseKeyringRef, redactSecrets } from '../src/v2/persistence/accounts';

const KEYRING_SERVICE = 'formaition-mcp';

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      'usage:',
      '  npm run account -- add <id> --host H [--port N] --user U --prefix P',
      '                        [--secret-prompt | --secret-env VAR | --secret-file PATH | --no-secret]',
      '                        [--tls off|preferred|required]',
      '  npm run account -- list',
      '  npm run account -- test <id>',
      '  npm run account -- remove <id>',
      `accounts file: ${resolveAccountsPath()}`,
    ].join('\n'),
  );
  process.exit(msg ? 2 : 0);
}

function flags(args: string[]): Map<string, string | true> {
  const m = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      m.set(a.slice(2), next);
      i++;
    } else {
      m.set(a.slice(2), true);
    }
  }
  return m;
}

function str(f: Map<string, string | true>, k: string): string | undefined {
  const v = f.get(k);
  return typeof v === 'string' ? v : undefined;
}

async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function add(id: string | undefined, f: Map<string, string | true>): Promise<void> {
  if (!id) usage('add: missing <id>');
  const secretModes = ['secret-prompt', 'secret-env', 'secret-file', 'no-secret'].filter((k) => f.has(k));
  if (secretModes.length !== 1) {
    usage('add: choose exactly one of --secret-prompt, --secret-env, --secret-file, --no-secret');
  }

  let secretRef: string | null = null;
  if (f.has('secret-env')) secretRef = `env:${str(f, 'secret-env') ?? usage('--secret-env needs a VAR')}`;
  if (f.has('secret-file')) secretRef = `file:${str(f, 'secret-file') ?? usage('--secret-file needs a PATH')}`;
  if (f.has('secret-prompt')) secretRef = `keyring:${KEYRING_SERVICE}/${id}`;

  const candidate = {
    id,
    driver: 'dolt' as const,
    host: str(f, 'host') ?? usage('add: --host is required'),
    port: Number(str(f, 'port') ?? '3306'),
    user: str(f, 'user') ?? usage('add: --user is required'),
    secret_ref: secretRef,
    tls: (str(f, 'tls') ?? 'off') as StorageAccount['tls'],
    database_prefix: str(f, 'prefix') ?? usage('add: --prefix is required'),
  };
  const parsed = StorageAccountSchema.safeParse(candidate);
  if (!parsed.success) usage(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  if (f.has('secret-prompt')) {
    const secret = await promptHidden(`Password for ${candidate.user}@${candidate.host} (stored in the OS keyring): `);
    if (!secret) usage('empty password; use --no-secret for accounts without one');
    const { service, account } = parseKeyringRef(secretRef!);
    new Entry(service, account).setPassword(secret);
  }

  const others = getStorageAccounts().filter((a) => a.id !== id);
  writeStorageAccounts([...others, parsed.data]);
  console.log(`account '${id}' saved to ${resolveAccountsPath()} (secret: ${secretRef ?? 'none'})`);
}

function list(): void {
  const accounts = getStorageAccounts();
  if (accounts.length === 0) {
    console.log(`no storage accounts (${resolveAccountsPath()})`);
    return;
  }
  for (const a of accounts) {
    const secretKind = a.secret_ref ? a.secret_ref.split(':')[0] : 'none';
    console.log(`${a.id}\t${a.user}@${a.host}:${a.port}\ttls=${a.tls}\tprefix=${a.database_prefix}\tsecret=${secretKind}`);
  }
}

async function test(id: string | undefined): Promise<void> {
  if (!id) usage('test: missing <id>');
  const account = getStorageAccounts().find((a) => a.id === id);
  if (!account) usage(`test: no account '${id}'`);
  const started = Date.now();
  try {
    const conn = await mysql.createConnection(connectionOptions(account));
    await conn.query('SELECT 1');
    await conn.end();
    console.log(`account '${id}': OK (${Date.now() - started} ms)`);
  } catch (e) {
    console.error(`account '${id}': FAILED — ${redactSecrets(String((e as Error).message ?? e))}`);
    process.exit(1);
  }
}

function remove(id: string | undefined): void {
  if (!id) usage('remove: missing <id>');
  const accounts = getStorageAccounts();
  const target = accounts.find((a) => a.id === id);
  if (!target) usage(`remove: no account '${id}'`);
  if (target.secret_ref?.startsWith('keyring:')) {
    const { service, account } = parseKeyringRef(target.secret_ref);
    try {
      new Entry(service, account).deletePassword();
    } catch {
      // already absent
    }
  }
  writeStorageAccounts(accounts.filter((a) => a.id !== id));
  console.log(`account '${id}' removed`);
}

async function main(): Promise<void> {
  const [cmd, maybeId, ...rest] = process.argv.slice(2);
  const id = maybeId && !maybeId.startsWith('--') ? maybeId : undefined;
  const f = flags(id ? rest : [maybeId ?? '', ...rest]);
  switch (cmd) {
    case 'add':
      return add(id, f);
    case 'list':
      return list();
    case 'test':
      return test(id);
    case 'remove':
      return remove(id);
    default:
      usage(cmd ? `unknown command '${cmd}'` : undefined);
  }
}

main().catch((e) => {
  console.error(redactSecrets(String((e as Error).message ?? e)));
  process.exit(1);
});
