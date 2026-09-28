/**
 * Storage accounts, secret resolution and redaction (spec 010, T011, SC-010).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import {
  getAccount,
  listAccounts,
  redactDeep,
  redactSecrets,
  resetKnownSecretsForTests,
  resolveSecret,
} from '../../src/v2/persistence/accounts';
import { McpToolError } from '../../src/mcp/errors';
import { dispatchGraphTool, graphToolDefinitions } from '../../src/v2/tools/graph';
import { toolSchemaFor } from '../../src/v2/schemas/tools';
import { GraphStore } from '../../src/v2/graph/store';
import { startDolt, type DoltHarness } from '../helpers/dolt-harness';

const SECRET = 'S3cr3t!-do-not-leak';

function writeAccounts(yamlBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-acc-'));
  const p = path.join(dir, 'storage-accounts.yaml');
  fs.writeFileSync(p, yamlBody);
  process.env['MCPCAD_ACCOUNTS'] = p;
  resetStorageAccountsCache();
  return p;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof McpToolError ? e.structured.code : String(e);
  }
  return undefined;
}

afterEach(() => {
  delete process.env['MCPCAD_ACCOUNTS'];
  delete process.env['T011_PW'];
  resetStorageAccountsCache();
  resetKnownSecretsForTests();
});

describe('[persist] storage accounts — config and secret resolution', () => {
  it('resolves env: and file: secrets and registers them for redaction', () => {
    const pwFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-pw-')), 'pw.txt');
    fs.writeFileSync(pwFile, `${SECRET}-file\n`);
    writeAccounts(
      [
        'storage_accounts:',
        '  - { id: a, driver: dolt, host: h, port: 1, user: u, secret_ref: "env:T011_PW", database_prefix: p_ }',
        `  - { id: b, driver: dolt, host: h, port: 1, user: u, secret_ref: "file:${pwFile.replace(/\\/g, '/')}", database_prefix: p_ }`,
      ].join('\n'),
    );
    process.env['T011_PW'] = SECRET;
    expect(resolveSecret(getAccount('a'))).toBe(SECRET);
    expect(resolveSecret(getAccount('b'))).toBe(`${SECRET}-file`);
    expect(redactSecrets(`pw=${SECRET} and ${SECRET}-file`)).toBe('pw=*** and ***');
    expect(redactDeep({ m: [`x ${SECRET}`] })).toEqual({ m: ['x ***'] });
  });

  it('an unresolvable secret names the reference, never a value', () => {
    writeAccounts(
      'storage_accounts:\n  - { id: a, driver: dolt, host: h, port: 1, user: u, secret_ref: "env:T011_PW", database_prefix: p_ }\n',
    );
    try {
      resolveSecret(getAccount('a'));
      expect.fail('should throw');
    } catch (e) {
      const s = (e as McpToolError).structured;
      expect(s.code).toBe('STORAGE_SECRET_UNRESOLVED');
      expect(s.message).toContain('env:T011_PW');
    }
  });

  it('rejects unknown secret_ref schemes and invalid ids at load', () => {
    writeAccounts(
      'storage_accounts:\n  - { id: a, driver: dolt, host: h, port: 1, user: u, secret_ref: "plain:hunter2", database_prefix: p_ }\n',
    );
    expect(codeOf(() => listAccounts())).toBe('STORAGE_CONFIG_INVALID');
    writeAccounts(
      'storage_accounts:\n  - { id: A!, driver: dolt, host: h, port: 1, user: u, secret_ref: null, database_prefix: p_ }\n',
    );
    expect(codeOf(() => listAccounts())).toBe('STORAGE_CONFIG_INVALID');
  });

  it('unknown account id → STORAGE_ACCOUNT_UNKNOWN', () => {
    writeAccounts('storage_accounts: []\n');
    expect(codeOf(() => getAccount('nope'))).toBe('STORAGE_ACCOUNT_UNKNOWN');
  });

  it('list_storage_accounts returns no secret_ref and no secret', async () => {
    writeAccounts(
      'storage_accounts:\n  - { id: a, driver: dolt, host: h, port: 1, user: u, secret_ref: "env:T011_PW", database_prefix: p_ }\n',
    );
    const out = (await dispatchGraphTool(new GraphStore(), 'list_storage_accounts', {})) as {
      accounts: Record<string, unknown>[];
    };
    expect(out.accounts).toEqual([{ id: 'a', driver: 'dolt', host: 'h', port: 1, tls: 'off', database_prefix: 'p_' }]);
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('[persist] no credential ever crosses the tool surface (SC-010 guard)', () => {
  const FORBIDDEN = /pass(word)?|secret|credential/i;

  function propertyNames(schema: unknown, acc: string[] = []): string[] {
    if (schema && typeof schema === 'object') {
      const obj = schema as Record<string, unknown>;
      if (obj['properties'] && typeof obj['properties'] === 'object') {
        for (const [k, v] of Object.entries(obj['properties'] as Record<string, unknown>)) {
          acc.push(k);
          propertyNames(v, acc);
        }
      }
      if (obj['items']) propertyNames(obj['items'], acc);
    }
    return acc;
  }

  it('no tool inputSchema declares a password/secret/credential property', () => {
    for (const def of graphToolDefinitions) {
      const names = propertyNames(def.inputSchema);
      for (const n of names) expect(`${def.name}.${n}`).not.toMatch(new RegExp(`\\.(${FORBIDDEN.source})`, 'i'));
    }
  });

  it('no Zod tool schema accepts a password/secret/credential key', () => {
    for (const def of graphToolDefinitions) {
      const schema = toolSchemaFor(def.name) as { shape?: Record<string, unknown> } | undefined;
      const keys = Object.keys(schema?.shape ?? {});
      for (const k of keys) expect(`${def.name}.${k}`).not.toMatch(new RegExp(`\\.(${FORBIDDEN.source})`, 'i'));
    }
  });
});

describe('[persist] authentication failure is reported without leaking the secret', () => {
  let h: DoltHarness;

  beforeAll(async () => {
    h = await startDolt();
    const c = await h.connect();
    await c.query("CREATE USER 'svc'@'%' IDENTIFIED BY 'the-right-one'");
    await c.end();
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('test_storage_account with a wrong password → STORAGE_AUTH_FAILED, secret absent from all output', async () => {
    writeAccounts(
      [
        'storage_accounts:',
        `  - { id: bad, driver: dolt, host: ${h.host}, port: ${h.port}, user: svc, secret_ref: "env:T011_PW", database_prefix: p_ }`,
      ].join('\n'),
    );
    process.env['T011_PW'] = SECRET;

    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let structured: Record<string, unknown> | undefined;
    try {
      await dispatchGraphTool(new GraphStore(), 'test_storage_account', { account: 'bad' });
    } catch (e) {
      structured = (e as McpToolError).structured as unknown as Record<string, unknown>;
    } finally {
      process.stderr.write = origWrite;
    }

    expect(structured?.['code']).toBe('STORAGE_AUTH_FAILED');
    const everything = JSON.stringify(structured) + captured.join('');
    expect(everything).not.toContain(SECRET);
  });

  it('test_storage_account with the right password → ok', async () => {
    writeAccounts(
      [
        'storage_accounts:',
        `  - { id: good, driver: dolt, host: ${h.host}, port: ${h.port}, user: svc, secret_ref: "env:T011_PW", database_prefix: p_ }`,
      ].join('\n'),
    );
    process.env['T011_PW'] = 'the-right-one';
    const out = (await dispatchGraphTool(new GraphStore(), 'test_storage_account', { account: 'good' })) as {
      ok: boolean;
      latency_ms: number;
    };
    expect(out.ok).toBe(true);
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('unreachable host → STORAGE_ACCOUNT_UNREACHABLE', async () => {
    writeAccounts(
      'storage_accounts:\n  - { id: gone, driver: dolt, host: 127.0.0.1, port: 1, user: root, secret_ref: null, database_prefix: p_ }\n',
    );
    await expect(dispatchGraphTool(new GraphStore(), 'test_storage_account', { account: 'gone' })).rejects.toMatchObject({
      structured: { code: 'STORAGE_ACCOUNT_UNREACHABLE' },
    });
  });
});
