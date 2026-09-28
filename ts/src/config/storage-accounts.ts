/**
 * Storage accounts — the MCP server's own "account setup" (spec 010,
 * research R-014). Each account is a named, credential-bearing connection to
 * a Dolt server. Clients refer to accounts **by id only**; credentials never
 * travel through tool calls. Secrets are never stored inline in the config:
 * `secret_ref` points at the OS keyring, an environment variable, or a file.
 *
 * Stored in their own, git-ignored file — `MCPCAD_ACCOUNTS`, else
 * `ts/config/storage-accounts.yaml` — not in the committed, commented
 * `config.yaml`: the account CLI rewrites this file, and accounts are
 * machine/tenant-specific. The file holds no secrets, only references.
 * Validated with Zod; an invalid file is a hard error, never silently
 * ignored (Principle IX). A leftover `persistence:` block in `config.yaml`
 * is rejected with migration instructions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

export const SECRET_REF_PATTERN = /^(keyring:[^/\s]+\/\S+|env:[A-Z_][A-Z0-9_]*|file:.+)$/;

export const StorageAccountSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'account id: lowercase letters, digits, _ or -'),
    driver: z.literal('dolt'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1),
    secret_ref: z.string().regex(SECRET_REF_PATTERN, 'secret_ref must be keyring:<service>/<account>, env:<VAR> or file:<path>').nullable(),
    tls: z.enum(['off', 'preferred', 'required']).default('off'),
    database_prefix: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'database_prefix: lowercase letters, digits and _'),
  })
  .strict();

export type StorageAccount = z.infer<typeof StorageAccountSchema>;

const StorageAccountsSchema = z
  .array(StorageAccountSchema)
  .superRefine((accounts, ctx) => {
    const seen = new Set<string>();
    for (const [i, a] of accounts.entries()) {
      if (seen.has(a.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: `duplicate account id '${a.id}'` });
      }
      seen.add(a.id);
    }
  });

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

export function resolveAccountsPath(): string {
  return process.env['MCPCAD_ACCOUNTS'] || path.resolve(__dirname, '../../config/storage-accounts.yaml');
}

function resolveMainConfigPath(): string {
  return process.env['MCPCAD_CONFIG'] || path.resolve(__dirname, '../../config/config.yaml');
}

function rejectLegacyPersistenceBlock(): void {
  const cfg = resolveMainConfigPath();
  if (!fs.existsSync(cfg)) return;
  let raw: Record<string, unknown> = {};
  try {
    raw = (yaml.load(fs.readFileSync(cfg, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch {
    return; // config.yaml validity is the nesting loader's concern
  }
  if (raw['persistence'] !== undefined) {
    throw new StorageConfigError(
      `config ${cfg} has the removed 'persistence:' block. Delete it and configure storage accounts ` +
        `instead: 'npm run account -- add <id> --host ... --user ... --prefix ...' (see docs/CONFIG.md).`,
    );
  }
}

let cache: { path: string; mtimeMs: number; accounts: StorageAccount[] } | null = null;

/**
 * All configured storage accounts. Re-reads when the config path or its mtime
 * changes (the account CLI edits the file while a server may be running, and
 * tests point MCPCAD_ACCOUNTS at temp files).
 */
export function getStorageAccounts(): StorageAccount[] {
  rejectLegacyPersistenceBlock();
  const configPath = resolveAccountsPath();
  if (!fs.existsSync(configPath)) return [];
  const mtimeMs = fs.statSync(configPath).mtimeMs;
  if (cache && cache.path === configPath && cache.mtimeMs === mtimeMs) return cache.accounts;

  let raw: Record<string, unknown>;
  try {
    raw = (yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new StorageConfigError(`accounts file ${configPath} is not valid YAML: ${(e as Error).message}`);
  }

  const parsed = StorageAccountsSchema.safeParse(raw['storage_accounts'] ?? []);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `storage_accounts.${i.path.join('.')}: ${i.message}`).join('; ');
    throw new StorageConfigError(`accounts file ${configPath}: ${detail}`);
  }

  cache = { path: configPath, mtimeMs, accounts: parsed.data };
  return parsed.data;
}

/** Test hook: forget the cached accounts. */
export function resetStorageAccountsCache(): void {
  cache = null;
}

/**
 * Rewrites `storage_accounts` in the config file, preserving every other key.
 * Used only by the account CLI (scripts/account-cli.ts).
 */
export function writeStorageAccounts(accounts: StorageAccount[]): void {
  const parsed = StorageAccountsSchema.parse(accounts);
  const configPath = resolveAccountsPath();
  const raw = fs.existsSync(configPath)
    ? ((yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>)
    : {};
  raw['storage_accounts'] = parsed;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(raw, { lineWidth: 120 }));
  fs.renameSync(tmp, configPath);
  cache = null;
}
