/**
 * Per-MCP-session state (spec 010, T023): the GraphStore plus, once a
 * project is bound, its GraphPersistence and the identity shadows. Nothing
 * here is module-global, so a future multi-session server can hold several.
 */

import { ErrorCodes, throwError } from '../../mcp/errors';
import { GraphStore } from '../graph/store';
import type { GraphPersistence, ClientMetaRow, ProjectSettingsRow } from './port';
import type { ShadowStore } from './row-mapper';
import { validateRawLoad } from './load';
import type { RawLoad } from './port';

export interface BoundProject {
  account: string;
  database: string;
  persistence: GraphPersistence;
  shadows: ShadowStore;
}

export class SessionContext {
  bound: BoundProject | null = null;

  constructor(readonly store: GraphStore = new GraphStore()) {}

  requireBound(): BoundProject {
    if (!this.bound) {
      throwError(ErrorCodes.PERSIST_NOT_BOUND, 'no project is open — call open_project first', true, 'open_project');
    }
    return this.bound;
  }

  /**
   * Validates `raw` completely, THEN replaces the store's contents. On any
   * validation error the store is left empty (never partially loaded) and the
   * error propagates.
   */
  loadIntoStore(raw: RawLoad, ref: string): { clientMeta: ClientMetaRow[]; settings: ProjectSettingsRow } {
    let validated;
    try {
      validated = validateRawLoad(raw, ref);
    } catch (e) {
      this.store.clear();
      throw e;
    }
    this.store.clear();
    for (const s of validated.snapshots) this.store.restorePart(s);
    if (this.bound) this.bound.shadows = validated.shadows;
    return { clientMeta: raw.clientMeta, settings: raw.settings };
  }

  async unbind(): Promise<void> {
    const b = this.bound;
    this.bound = null;
    this.store.clear();
    await b?.persistence.close();
  }
}
