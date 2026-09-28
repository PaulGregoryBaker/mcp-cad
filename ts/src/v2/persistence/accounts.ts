/**
 * Storage account resolution, secret handling and redaction (spec 010, R-014).
 *
 * Secrets are resolved lazily, only when a connection is made, from the
 * account's `secret_ref` (OS keyring, env var or file). They are held in this
 * module's private registry so every log and error path can be scrubbed by
 * redactSecrets(). No exported function returns a secret except
 * connectionOptions(), whose result goes straight to mysql2.
 *
 * Credentials never arrive through MCP tool calls — only account ids do.
 */

import * as fs from 'fs';
import { Entry } from '@napi-rs/keyring';
import type { ConnectionOptions } from 'mysql2/promise';
import { ErrorCodes, throwError } from '../../mcp/errors';
import {
  getStorageAccounts,
  StorageConfigError,
  type StorageAccount,
} from '../../config/storage-accounts';

/** Every secret this process has resolved, for redaction. */
const knownSecrets = new Set<string>();

/** Minimum length before a value is treated as redactable (avoids masking "a"). */
const MIN_REDACT_LEN = 3;

function remember(secret: string): void {
  if (secret.length >= MIN_REDACT_LEN) knownSecrets.add(secret);
}

/** Replaces every resolved secret in `text` with `***`. */
export function redactSecrets(text: string): string {
  if (knownSecrets.size === 0) return text;
  let out = text;
  // Longest first: if one secret is a prefix of another, replacing the short
  // one first would leave the long one's tail visible.
  for (const s of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

/** Deep redaction for structured error details / log objects. */
export function redactDeep<T>(value: T): T {
  if (knownSecrets.size === 0) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** Test hook: forget resolved secrets. */
export function resetKnownSecretsForTests(): void {
  knownSecrets.clear();
}

/** Test hook: register a value as a secret without resolving an account. */
export function registerSecretForTests(secret: string): void {
  remember(secret);
}

export function listAccounts(): StorageAccount[] {
  try {
    return getStorageAccounts();
  } catch (e) {
    if (e instanceof StorageConfigError) {
      throwError(ErrorCodes.STORAGE_CONFIG_INVALID, e.message, false);
    }
    throw e;
  }
}

export function getAccount(id: string): StorageAccount {
  const account = listAccounts().find((a) => a.id === id);
  if (!account) {
    throwError(
      ErrorCodes.STORAGE_ACCOUNT_UNKNOWN,
      `No storage account '${id}' is configured. Add it with 'npm run account -- add ${id} ...' in the MCP server's account setup.`,
      false,
    );
  }
  return account;
}

/** Keyring service/account names for a `keyring:<service>/<account>` ref. */
export function parseKeyringRef(ref: string): { service: string; account: string } {
  const body = ref.slice('keyring:'.length);
  const slash = body.indexOf('/');
  return { service: body.slice(0, slash), account: body.slice(slash + 1) };
}

/** Human-safe description of a secret_ref: scheme + key, never a value. */
function describeRef(ref: string): string {
  if (ref.startsWith('file:')) return 'file reference';
  return ref; // keyring:<service>/<account> and env:<VAR> name no secret
}

/**
 * Resolves an account's secret (null when the account has none). Throws
 * STORAGE_SECRET_UNRESOLVED naming the reference, never a value.
 */
export function resolveSecret(account: StorageAccount): string | null {
  const ref = account.secret_ref;
  if (ref === null) return null;

  let secret: string | null | undefined;
  try {
    if (ref.startsWith('env:')) {
      secret = process.env[ref.slice('env:'.length)];
    } else if (ref.startsWith('file:')) {
      const p = ref.slice('file:'.length);
      secret = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : undefined;
    } else if (ref.startsWith('keyring:')) {
      const { service, account: acct } = parseKeyringRef(ref);
      secret = new Entry(service, acct).getPassword();
    }
  } catch {
    secret = undefined;
  }

  if (secret === undefined || secret === null || secret === '') {
    throwError(
      ErrorCodes.STORAGE_SECRET_UNRESOLVED,
      `Storage account '${account.id}': secret could not be resolved from ${describeRef(ref)}. ` +
        `Re-run 'npm run account -- add ${account.id} ...' or set the referenced value.`,
      false,
    );
  }
  remember(secret);
  return secret;
}

/** mysql2 connection options for an account (optionally bound to a database). */
export function connectionOptions(account: StorageAccount, database?: string): ConnectionOptions {
  const password = resolveSecret(account) ?? '';
  const opts: ConnectionOptions = {
    host: account.host,
    port: account.port,
    user: account.user,
    password,
    database,
    multipleStatements: true,
    connectTimeout: 10_000,
  };
  if (account.tls !== 'off') {
    opts.ssl = { rejectUnauthorized: account.tls === 'required' };
  }
  return opts;
}

/**
 * Maps a mysql2/network error to a storage error with a redacted message.
 * `phase` distinguishes connecting from writing.
 */
export function storageErrorFrom(err: unknown, account: StorageAccount, phase: 'connect' | 'write'): never {
  const e = err as { code?: string; errno?: number; message?: string };
  const raw = redactSecrets(String(e?.message ?? err));
  const code = e?.code ?? '';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR' || /access denied/i.test(raw)) {
    throwError(
      ErrorCodes.STORAGE_AUTH_FAILED,
      `Storage account '${account.id}' was rejected by ${account.host}:${account.port} (authentication failed). ` +
        `Check the account in the MCP server's account setup.`,
      false,
    );
  }
  if (phase === 'connect' || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST'].includes(code)) {
    throwError(
      ErrorCodes.STORAGE_ACCOUNT_UNREACHABLE,
      `Storage account '${account.id}' at ${account.host}:${account.port} is unreachable (${code || 'error'}): ${raw}`,
      true,
    );
  }
  throwError(ErrorCodes.PERSIST_WRITE_FAILED, `Storage write failed (${code || 'error'}): ${raw}`, true);
}
