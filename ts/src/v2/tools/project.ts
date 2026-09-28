/**
 * Project lifecycle, versioning and settings tools (spec 010; contract
 * mcp-persistence-contract.md). All take account/database NAMES only —
 * credentials come from the server's account setup (R-014).
 */

import { ErrorCodes, throwError } from '../../mcp/errors';
import { getAccount } from '../persistence/accounts';
import {
  createProjectDatabase,
  dropProjectDatabase,
  DoltPersistence,
  listProjectDatabases,
} from '../persistence/dolt-persistence';
import { persistMutation } from '../persistence/persist-mutation';
import type { ClientMetaRow, ProjectSettingsRow } from '../persistence/port';
import type { SessionContext } from '../persistence/session';
import { ProjectSettingsPatchSchema } from '../schemas/persistence';

const str = { type: 'string' } as const;

export const projectToolDefinitions = [
  {
    name: 'create_project',
    description:
      'Create a new, empty project database on a configured storage account (by id) and migrate it. The client chooses the account and database name; credentials come from the server account setup.',
    inputSchema: { type: 'object', properties: { account: str, database: str, name: str }, required: ['account', 'database', 'name'] },
  },
  {
    name: 'drop_project',
    description: 'Permanently delete a project database. Refused while that project is open.',
    inputSchema: { type: 'object', properties: { account: str, database: str }, required: ['account', 'database'] },
  },
  {
    name: 'list_projects',
    description: 'List project databases on a storage account (databases with the account prefix) and their names.',
    inputSchema: { type: 'object', properties: { account: str }, required: ['account'] },
  },
  {
    name: 'open_project',
    description:
      'Bind this session to a project: connect, migrate (main first, then the saved branch), validate everything, then load the whole manufacturing graph into memory (replacing whatever was loaded). On any error nothing is loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        account: str,
        database: str,
        author: { type: 'object', properties: { name: str, email: str }, required: ['name', 'email'] },
      },
      required: ['account', 'database', 'author'],
    },
  },
  {
    name: 'refresh_project',
    description: 'Re-read the bound branch (including uncommitted work) or read-only revision and reload memory. Never switches branch; no dirty check.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'close_project',
    description: 'Unbind the project and clear memory.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'branch_begin',
    description:
      'Open the working branch wip/<label>, forked from the viewed read-only revision if one is checked out, else from the current branch. replace_existing deletes an existing CLEAN working branch first.',
    inputSchema: { type: 'object', properties: { label: str, replace_existing: { type: 'boolean' } }, required: ['label'] },
  },
  {
    name: 'commit',
    description: 'Create a revision from all uncommitted work on the working branch (user-chosen; edits never commit by themselves).',
    inputSchema: { type: 'object', properties: { message: str }, required: ['message'] },
  },
  {
    name: 'discard_changes',
    description: 'Drop all uncommitted work on the working branch (back to its last commit) and reload.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'undo',
    description: 'Reverse the most recent uncommitted operation and reload. Never goes past the last commit.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'branch_merge',
    description: 'Merge the (clean) working branch into main (--no-ff) and delete it.',
    inputSchema: { type: 'object', properties: { message: str }, required: ['message'] },
  },
  {
    name: 'branch_discard',
    description: 'Delete the working branch (its commits and uncommitted work) and reload main.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'checkout',
    description: 'Switch to a branch, or view a commit read-only. Refused while there is uncommitted work.',
    inputSchema: { type: 'object', properties: { ref: str }, required: ['ref'] },
  },
  {
    name: 'update_project_settings',
    description: 'Set project settings (manufacturing_profile, manufacturing_defaults, nesting). Saved like an edit (uncommitted, undoable).',
    inputSchema: {
      type: 'object',
      properties: { manufacturing_profile: { type: 'object' }, manufacturing_defaults: { type: 'object' }, nesting: { type: 'object' } },
      required: [],
    },
  },
  {
    name: 'update_client_meta',
    description: "Store the client's per-part presentation document (opaque to the server). Saved like an edit.",
    inputSchema: { type: 'object', properties: { part_id: str, doc: { type: 'object' } }, required: ['part_id', 'doc'] },
  },
];

// ─── Results ─────────────────────────────────────────────────────────────────

export interface OpenProjectResult {
  branch: string;
  read_only_ref: string | null;
  head_commit: string;
  dirty: boolean;
  uncommitted_ops: number;
  unmerged_commits: number;
  schema_migrated: boolean;
  parts: Array<{ part_id: string; merged_into_part_id: string | null }>;
  settings: ProjectSettingsRow;
  client_meta: ClientMetaRow[];
}

async function stateResult(ctx: SessionContext, loaded: { clientMeta: ClientMetaRow[]; settings: ProjectSettingsRow }, schemaMigrated: boolean): Promise<OpenProjectResult> {
  const b = ctx.requireBound();
  const st = await b.persistence.status();
  return {
    branch: b.persistence.branch,
    read_only_ref: b.persistence.readOnlyRef,
    head_commit: st.headCommit,
    dirty: st.dirty,
    uncommitted_ops: st.uncommittedOps,
    unmerged_commits: st.unmergedCommits,
    schema_migrated: schemaMigrated,
    parts: ctx.store.partIds().map((id) => ({ part_id: id, merged_into_part_id: ctx.store.getPart(id)!.mergedIntoPartId })),
    settings: loaded.settings,
    client_meta: loaded.clientMeta,
  };
}

async function reload(ctx: SessionContext, schemaMigrated = false): Promise<OpenProjectResult> {
  const b = ctx.requireBound();
  const raw = await b.persistence.readCurrent();
  const ref = b.persistence.readOnlyRef ?? b.persistence.branch;
  const loaded = ctx.loadIntoStore(raw, ref);
  return stateResult(ctx, loaded, schemaMigrated);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleProjectTool(ctx: SessionContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'create_project': {
      const account = getAccount(String(args['account']));
      await createProjectDatabase(account, String(args['database']), String(args['name']));
      return {};
    }
    case 'drop_project': {
      const database = String(args['database']);
      if (ctx.bound && ctx.bound.database === database && ctx.bound.account === args['account']) {
        throwError(ErrorCodes.PERSIST_PROJECT_OPEN, `project ${database} is open; close it first`, true, 'close_project');
      }
      await dropProjectDatabase(getAccount(String(args['account'])), database);
      return {};
    }
    case 'list_projects':
      return { projects: await listProjectDatabases(getAccount(String(args['account']))) };

    case 'open_project': {
      const accountId = String(args['account']);
      const database = String(args['database']);
      const author = args['author'] as { name: string; email: string };
      const account = getAccount(accountId);
      await ctx.unbind(); // FR-005: nothing from a previously open project survives
      const persistence = await DoltPersistence.connect(account, database, author);
      ctx.bound = { account: accountId, database, persistence, shadows: new Map() };
      try {
        const opened = await persistence.open();
        const loaded = ctx.loadIntoStore(opened.raw, persistence.branch);
        return await stateResult(ctx, loaded, opened.schemaMigrated);
      } catch (e) {
        await ctx.unbind();
        throw e;
      }
    }
    case 'refresh_project':
      return reload(ctx);
    case 'close_project':
      await ctx.unbind();
      return {};

    case 'branch_begin': {
      const b = ctx.requireBound();
      const r = await b.persistence.branchBegin(String(args['label']), args['replace_existing'] === true);
      if (b.persistence.readOnlyRef === null) {
        // forked from a viewed revision: memory already shows it; re-read to be exact
        await reload(ctx);
      }
      return { branch: r.branch, forked_from: r.forkedFrom };
    }
    case 'commit': {
      const r = await ctx.requireBound().persistence.commit(String(args['message']));
      return { commit_hash: r.commitHash, ops: r.ops };
    }
    case 'discard_changes':
      await ctx.requireBound().persistence.discardChanges();
      return reload(ctx);
    case 'undo': {
      const seq = await ctx.requireBound().persistence.undoLast();
      return { ...(await reload(ctx)), undone_seq: seq };
    }
    case 'branch_merge': {
      const r = await ctx.requireBound().persistence.branchMerge(String(args['message']));
      await reload(ctx);
      return { merge_commit: r.mergeCommit };
    }
    case 'branch_discard':
      await ctx.requireBound().persistence.branchDiscard();
      return reload(ctx);
    case 'checkout': {
      const r = await ctx.requireBound().persistence.checkout(String(args['ref']));
      return reload(ctx, r.migrated);
    }

    case 'update_project_settings': {
      const patch = { ...args };
      delete patch['actor'];
      const parsed = ProjectSettingsPatchSchema.safeParse(patch);
      if (!parsed.success) {
        const i = parsed.error.issues[0]!;
        throwError(ErrorCodes.SETTINGS_INVALID, `${i.path.join('.')}: ${i.message}`, true, undefined, { details: { path: i.path.join('.') } });
      }
      return persistMutation(ctx, name, args, () => ({}), {
        allowEmptyGraphDiff: true,
        side: () => ({ settingsPatch: parsed.data as Partial<ProjectSettingsRow> }),
      });
    }
    case 'update_client_meta': {
      const partId = String(args['part_id']);
      if (!ctx.store.getPart(partId)) throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, true);
      const doc = args['doc'] as Record<string, unknown>;
      if (JSON.stringify(doc).length > 64 * 1024) throwError(ErrorCodes.SETTINGS_INVALID, 'client_meta doc exceeds 64 KB', true);
      return persistMutation(ctx, name, args, () => ({}), {
        allowEmptyGraphDiff: true,
        side: () => ({ clientMetaUpserts: [{ part_id: partId, doc }] }),
      });
    }
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown v2 tool: ${name}`, false);
  }
}

export const PROJECT_TOOL_NAMES = new Set(projectToolDefinitions.map((d) => d.name));
