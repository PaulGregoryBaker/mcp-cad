/**
 * import_part on the persistent (session) path — spec 010 T063, contract
 * §import_part. Resolves `{preview_id}` or `{file}` through the preview cache,
 * applies the ImportConfig transform, builds the graph at the chosen thickness
 * (mid-surface kept, C++ ReconcilePieces) with the chosen material and the
 * project's K-factor, and writes — as ONE action_log operation — the graph
 * rows, the import_source row and a client_meta doc per created part (display
 * names; grouped under this import).
 *
 * The in-memory engine (dispatchGraphTool) keeps its plain `{file}` import for
 * the geometry test suites; production always comes through here.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorCodes, throwError } from '../../mcp/errors';
import type { NapiManufacturingProfile } from '../../geometry/types';
import { importPartFromSolid } from '../graph/evaluate-client';
import { GraphStoreError } from '../graph/store';
import { isCatalogueThickness, isMaterialId, kFactorForProcess } from '../graph/thickness-catalogue';
import { persistMutation } from '../persistence/persist-mutation';
import type { ClientMetaRow } from '../persistence/port';
import type { SessionContext } from '../persistence/session';
import { StoredImportConfigSchema } from '../schemas/persistence';
import { applyImportTransform, disposableCopy, measuredThicknessMm, resolvePreviewSource } from './import-preview';

export interface ConfiguredImportResult {
  part_id: string;
  panel_count: number;
  protrusion_count: number;
  bend_count: number;
  notes: string[];
  protrusion_part_ids: string[];
  component_part_ids: string[];
  import_source_id: string;
  measured_thickness_mm: number | null;
}

export async function handleConfiguredImport(
  ctx: SessionContext,
  args: Record<string, unknown>,
  profile: NapiManufacturingProfile | undefined,
): Promise<ConfiguredImportResult & { action_seq: number | null }> {
  const bound = ctx.requireBound();
  const importSourceId = randomUUID();
  let side: { importSource: Parameters<typeof toSide>[0]; meta: ClientMetaRow[] } | null = null;

  return persistMutation(
    ctx,
    'import_part',
    args,
    async (): Promise<ConfiguredImportResult> => {
      const cfg = StoredImportConfigSchema.safeParse(args['config']);
      if (!cfg.success) {
        throwError(
          ErrorCodes.INVALID_TOOL_ARGS,
          `import_part: config — ${cfg.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          true,
        );
      }
      const config = cfg.data;

      const settings = await bound.persistence.readSettings();
      const defaults = settings.manufacturing_defaults as { defaultMaterial?: string; defaultThicknessMm?: number; preferredBendProcesses?: string[] } | null;
      if (!defaults?.defaultMaterial || !defaults.defaultThicknessMm) {
        throwError(
          ErrorCodes.IMPORT_DEFAULTS_MISSING,
          'the project has no default material and thickness yet; set them (update_project_settings) before importing',
          true,
          'update_project_settings',
        );
      }
      if (!isMaterialId(config.materialId) || !isCatalogueThickness(config.materialId, config.thicknessMm)) {
        throwError(
          ErrorCodes.IMPORT_THICKNESS_NOT_IN_CATALOGUE,
          `${config.thicknessMm} mm ${config.materialId} is not a standard sheet thickness`,
          true,
        );
      }

      const notes: string[] = [];
      const process = defaults.preferredBendProcesses?.[0];
      const kFactor = kFactorForProcess(process);
      if (kFactor === null) {
        notes.push(`K-factor: no published range for bend process "${process ?? 'none'}"; bends keep K = 0 until set`);
      }

      const entry = resolvePreviewSource({
        file: typeof args['file'] === 'string' ? args['file'] : undefined,
        preview_id: typeof args['preview_id'] === 'string' ? args['preview_id'] : undefined,
      });
      const solid = applyImportTransform(entry, config);
      const stem = path.parse(entry.filePath).name;

      let r;
      try {
        r = importPartFromSolid(ctx.store, disposableCopy(solid.solidId), {
          name: stem,
          thicknessMm: config.thicknessMm,
          materialId: config.materialId,
          kFactor: kFactor ?? undefined,
          profile,
          angleThresholdDeg: typeof args['angle_threshold_deg'] === 'number' ? args['angle_threshold_deg'] : undefined,
          maxRecursionDepth: typeof args['max_recursion_depth'] === 'number' ? args['max_recursion_depth'] : undefined,
        });
      } catch (err) {
        if (err instanceof GraphStoreError) throwError(err.code, err.message, false);
        throw err;
      }

      const measured = measuredThicknessMm(entry, config);
      const doc = (displayName: string) => ({
        v: 1,
        displayName,
        groupId: importSourceId,
        groupName: stem,
        hidden: false,
        excludedFromNesting: false,
        importSourceId,
      });
      side = {
        importSource: {
          import_source_id: importSourceId,
          file_path: entry.filePath,
          file_sha256: entry.sha256,
          config: config as unknown as Record<string, unknown>,
          measured_thickness_mm: measured,
        },
        meta: [
          { part_id: r.partId, doc: doc(stem) },
          ...r.componentPartIds.map((id, i) => ({ part_id: id, doc: doc(`Component ${i + 1}`) })),
          ...r.protrusionPartIds.map((id, i) => ({ part_id: id, doc: doc(`Protrusion ${i + 1}`) })),
        ],
      };

      return {
        part_id: r.partId,
        panel_count: r.panelCount,
        protrusion_count: r.protrusionCount,
        bend_count: r.bendCount,
        notes: [...r.notes, ...notes],
        protrusion_part_ids: r.protrusionPartIds,
        component_part_ids: r.componentPartIds,
        import_source_id: importSourceId,
        measured_thickness_mm: measured,
      };
    },
    { side: () => (side ? toSide(side.importSource, side.meta) : {}) },
  );
}

function toSide(importSource: {
  import_source_id: string;
  file_path: string;
  file_sha256: string;
  config: Record<string, unknown>;
  measured_thickness_mm: number | null;
}, meta: ClientMetaRow[]) {
  return { importSource, clientMetaUpserts: meta };
}
