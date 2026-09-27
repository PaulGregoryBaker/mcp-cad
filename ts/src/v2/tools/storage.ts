/**
 * Storage-account tools (spec 010, R-014, T010). Clients learn which accounts
 * exist and whether one is reachable — by id only. No tool here (or anywhere)
 * accepts or returns a credential.
 */

import mysql from 'mysql2/promise';
import { connectionOptions, getAccount, listAccounts, storageErrorFrom } from '../persistence/accounts';

export const storageToolDefinitions = [
  {
    name: 'list_storage_accounts',
    description:
      "List the storage accounts configured in this server's account setup (ids, hosts, TLS mode, database prefix). Never returns credentials — those live only in the server's account setup.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'test_storage_account',
    description:
      'Check that a configured storage account is reachable and its credentials are accepted (SELECT 1). Returns latency; errors are STORAGE_ACCOUNT_UNKNOWN / STORAGE_ACCOUNT_UNREACHABLE / STORAGE_AUTH_FAILED / STORAGE_SECRET_UNRESOLVED.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'Storage account id' } },
      required: ['account'],
    },
  },
];

export function handleListStorageAccounts(): {
  accounts: Array<{ id: string; driver: 'dolt'; host: string; port: number; tls: string; database_prefix: string }>;
} {
  return {
    accounts: listAccounts().map((a) => ({
      id: a.id,
      driver: a.driver,
      host: a.host,
      port: a.port,
      tls: a.tls,
      database_prefix: a.database_prefix,
    })),
  };
}

export async function handleTestStorageAccount(args: Record<string, unknown>): Promise<{ ok: true; latency_ms: number }> {
  const account = getAccount(String(args['account']));
  const opts = connectionOptions(account);
  const started = Date.now();
  let conn: mysql.Connection | undefined;
  try {
    conn = await mysql.createConnection(opts);
    await conn.query('SELECT 1');
  } catch (e) {
    storageErrorFrom(e, account, 'connect');
  } finally {
    await conn?.end().catch(() => undefined);
  }
  return { ok: true, latency_ms: Date.now() - started };
}
