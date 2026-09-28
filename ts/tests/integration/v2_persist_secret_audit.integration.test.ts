/**
 * T096 / SC-010 (spec 010, FR-031): a storage secret never leaves the MCP
 * server. Runs the REAL server process (dist/v2/server.js) over stdio against
 * a password-protected Dolt user whose secret is referenced from an env var,
 * drives the whole quickstart flow (create, open, settings, preview, import,
 * edit, undo, commit, history, actions, diff, revision reads, reference mesh,
 * merge) plus failure paths (wrong password, unknown database), and searches
 * every tool result, resource body, error and the server's entire stderr for
 * the secret: zero matches.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDolt, type DoltHarness } from '../helpers/dolt-harness';

const SECRET = 'Zq9-audit-S3cret-7f2c1d';
const WRONG = 'Wr0ng-audit-P4ss-91be';
const SERVER = path.resolve(__dirname, '../../dist/v2/server.js');
const FIXTURE = path.resolve(__dirname, '../../../cpp/tests/fixtures/l_bracket_corner_90deg.stp');

let h: DoltHarness;
let tmp: string;
let client: Client;
let stderr = '';
const seen: string[] = [];

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    seen.push(`${name}: ${text}`);
    if (r.isError) return { __error: text };
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e);
    seen.push(`${name} threw: ${msg}`);
    return { __error: msg };
  }
}

async function resource(uri: string): Promise<Record<string, any>> {
  try {
    const r = await client.readResource({ uri });
    const text = (r.contents as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    seen.push(`${uri}: ${text}`);
    return JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e);
    seen.push(`${uri} threw: ${msg}`);
    return { __error: msg };
  }
}

describe('[persist] SC-010 secret audit through the real MCP server', () => {
  beforeAll(async () => {
    expect(fs.existsSync(SERVER), 'build first: npm run build').toBe(true);
    h = await startDolt();
    const root = await h.connect();
    await root.query(`CREATE USER 'formaition'@'%' IDENTIFIED BY '${SECRET}'`);
    await root.query("GRANT ALL PRIVILEGES ON *.* TO 'formaition'@'%' WITH GRANT OPTION");
    await root.end();

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-audit-'));
    const accounts = path.join(tmp, 'storage-accounts.yaml');
    const account = (id: string, envVar: string) =>
      [`  - id: ${id}`, '    driver: dolt', `    host: ${h.host}`, `    port: ${h.port}`, '    user: formaition', `    secret_ref: env:${envVar}`, `    database_prefix: a_`].join('\n');
    fs.writeFileSync(accounts, ['storage_accounts:', account('secure', 'AUDIT_SECRET'), account('wrongpw', 'AUDIT_WRONG'), ''].join('\n'));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...(process.env as Record<string, string>),
        MCPCAD_ACCOUNTS: accounts,
        AUDIT_SECRET: SECRET,
        AUDIT_WRONG: WRONG,
        V2_BLOB_PORT: '0',
      },
      stderr: 'pipe',
    });
    // The pipe must exist, or "no matches in stderr" would prove nothing.
    // (On success the server writes nothing to stderr; it only logs
    // crashes and oversized-edit notices.)
    expect(transport.stderr).toBeTruthy();
    transport.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    client = new Client({ name: 'secret-audit', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await h?.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the full flow and its failure paths never expose the secret', async () => {
    // Account discovery and test.
    const list = await tool('list_storage_accounts');
    expect(list['accounts'].map((a: any) => a.id)).toEqual(['secure', 'wrongpw']);
    expect((await tool('test_storage_account', { account: 'secure' }))['ok']).toBe(true);
    const bad = await tool('test_storage_account', { account: 'wrongpw' });
    expect(JSON.stringify(bad)).toMatch(/STORAGE_AUTH_FAILED|ok":false/);

    // Quickstart flow.
    await tool('create_project', { account: 'secure', database: 'a_audit', name: 'Audit' });
    const open = await tool('open_project', { account: 'secure', database: 'a_audit', author: { name: 'Pat', email: 'pat@example.test' } });
    expect(open['__error']).toBeUndefined();
    await tool('branch_begin', { label: 'audit' });
    await tool('update_project_settings', {
      manufacturing_defaults: { defaultMaterial: 'mildSteel', defaultThicknessMm: 1.5, unitSystem: 'metric', preferredBendProcesses: ['airBend'] },
      nesting: { sheets: [{ widthMm: 2000, heightMm: 1000 }], safetyGapMm: 2, sheetMarginMm: 5, cuttingWidthMm: 0.2, rotationsDeg: [0, 90] },
    });
    const preview = await tool('preview_import', { file: FIXTURE });
    const config = {
      scale: { preset: 'mm', factor: 1 },
      rotation: { xQuarterTurns: 0, yQuarterTurns: 0, zQuarterTurns: 1 },
      recenter: { xy: true, z: 'floor' },
      thicknessMm: 1.5,
      materialId: 'mildSteel',
    };
    const imported = await tool('import_part', { preview_id: preview['preview_id'], config });
    expect(imported['import_source_id']).toBeTruthy();
    await tool('update_node', { kind: 'part', id: imported['part_id'], patch: { thickness_mm: 2.0 } });
    await tool('undo');
    const c1 = await tool('commit', { message: 'Imported bracket' });
    await tool('update_node', { kind: 'part', id: imported['part_id'], patch: { thickness_mm: 2.0 } });
    const c2 = await tool('commit', { message: 'Thicker' });
    const history = await resource('graph://history');
    expect(history['commits'].length).toBeGreaterThanOrEqual(2);
    await resource(`graph://ref/${c2['commit_hash']}/actions`);
    await resource('graph://ref/WORKING/actions');
    await resource(`graph://diff/${c1['commit_hash']}/${c2['commit_hash']}`);
    await resource(`graph://ref/${c1['commit_hash']}/parts`);
    await resource('graph://import-sources');
    await tool('reference_mesh', { import_source_id: imported['import_source_id'] });
    await tool('simulate_nesting', { part_ids: [imported['part_id']], sheet_width_mm: 2000, sheet_height_mm: 1000 });
    await tool('branch_merge', { message: 'Accept' });

    // Failure paths.
    await tool('close_project');
    await tool('open_project', { account: 'wrongpw', database: 'a_audit', author: { name: 'Pat', email: 'pat@example.test' } });
    await tool('open_project', { account: 'secure', database: 'a_does_not_exist', author: { name: 'Pat', email: 'pat@example.test' } });
    await tool('create_project', { account: 'wrongpw', database: 'a_other', name: 'x' });

    // Give the server a moment to flush stderr.
    await new Promise((r) => setTimeout(r, 300));
    const everything = [...seen, stderr].join('\n');
    expect(seen.length).toBeGreaterThan(20);
    expect(everything.includes(SECRET)).toBe(false);
    expect(everything.includes(WRONG)).toBe(false);
    console.log(`[SC-010] responses=${seen.length} stderr_bytes=${stderr.length} secret_matches=0`);
  }, 180_000);
});
