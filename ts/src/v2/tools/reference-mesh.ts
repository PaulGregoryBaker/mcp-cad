/**
 * reference_mesh (spec 010 US5, FR-024–FR-026, T085): re-imports an import
 * source's STEP file with its stored ImportConfig to produce a REFERENCE mesh
 * only — for visual comparison against the manufacturing graph. It never
 * builds or changes the graph: no store change, no write, no action_log row.
 *
 * `file_changed` reports that the file on disk no longer matches the hash
 * recorded at import (the overlay may not line up any more).
 */

import fs from 'node:fs';
import { geometryBinding } from '../../geometry/binding';
import { ErrorCodes, throwError } from '../../mcp/errors';
import { buildV2BlobUrl, v2BlobCache } from '../blob-cache';
import type { SessionContext } from '../persistence/session';
import { StoredImportConfigSchema } from '../schemas/persistence';
import { applyImportTransform, createPreview, fileSha256 } from './import-preview';

export interface ReferenceMeshOutput {
  import_source_id: string;
  glb_url: string;
  file_changed: boolean;
}

export async function handleReferenceMesh(ctx: SessionContext, args: Record<string, unknown>): Promise<ReferenceMeshOutput> {
  const bound = ctx.requireBound();
  const id = args['import_source_id'];
  if (typeof id !== 'string' || id.length === 0) {
    throwError(ErrorCodes.INVALID_TOOL_ARGS, 'reference_mesh: import_source_id is required', true);
  }
  const source = (await bound.persistence.readImportSources()).find((s) => s.import_source_id === id);
  if (!source) throwError(ErrorCodes.IMPORT_SOURCE_NOT_FOUND, `no import source ${id} in this project`, false);
  if (!fs.existsSync(source.file_path) || !fs.statSync(source.file_path).isFile()) {
    throwError(
      ErrorCodes.IMPORT_SOURCE_MISSING,
      `the imported file is no longer at ${source.file_path}; the reference overlay needs the original file`,
      true,
    );
  }
  const config = StoredImportConfigSchema.safeParse(source.config);
  if (!config.success) {
    throwError(ErrorCodes.PERSIST_CORRUPT_ROW, `import source ${id} has a malformed stored config`, false, undefined, {
      details: { table: 'import_source', key: id, issues: config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  const sha = fileSha256(source.file_path);
  const key = `reference/${id}/${sha.slice(0, 16)}`;
  if (!v2BlobCache.get(key)) {
    const entry = createPreview(source.file_path);
    const solid = applyImportTransform(entry, config.data);
    v2BlobCache.getOrRebuild(key, 'model/gltf-binary', sha, () => geometryBinding.exportGlb(solid.solidId));
  }
  return { import_source_id: id, glb_url: buildV2BlobUrl(key), file_changed: sha !== source.file_sha256 };
}

export const referenceMeshToolDefinitions = [
  {
    name: 'reference_mesh',
    description:
      "A GLB of an import source's original STEP file, re-imported with its stored import configuration (same scale, orientation and recentering), for overlaying on the manufacturing graph as a reference. Never changes the graph. file_changed=true when the file on disk differs from the one imported. IMPORT_SOURCE_MISSING when the file is gone. List sources with graph://import-sources.",
    inputSchema: {
      type: 'object',
      properties: { import_source_id: { type: 'string' } },
      required: ['import_source_id'],
    },
  },
];
