import { session, getSemanticPort } from '../geometry/session';
import type { ValidationError, ValidationReport } from '../geometry/types';
import type { ValidationContext, ValidationRule } from './types';
import { UnfoldRule } from './rules/unfold';
import { ClashRule } from './rules/clash';

export interface ValidateAssemblyParams {
  part_ids?: string[];
  sheet_metal_flags?: Record<string, boolean>;
}

export class ValidationEngine {
  private rules: ValidationRule[] = [];

  constructor() {
    this.registerRule(new UnfoldRule());
    this.registerRule(new ClashRule());
  }

  registerRule(rule: ValidationRule): void {
    this.rules.push(rule);
  }

  reset(): void {
    this.rules = [new UnfoldRule(), new ClashRule()];
  }

  async validate(params: ValidateAssemblyParams): Promise<ValidationReport> {
    const startTime = Date.now();

    // 1. Resolve which parts are being checked (C++ shell IDs)
    let partIds = params.part_ids ?? [];
    if (partIds.length === 0) {
      partIds = session.getActiveShellIds();
    }

    // 2. Fetch the sheet metal flags from params or default to empty
    const sheetMetalFlags = params.sheet_metal_flags ?? {};

    // 3. Gather database metadata & build semantic mapping
    const semanticToShell = new Map<string, string>();
    const shellToSemantic = new Map<string, string>();
    const adjacentPairs: [string, string][] = [];

    const port = getSemanticPort();
    if (port) {
      try {
        // Query all mappings to find which semantic entities bind to which C++ body/shell IDs
        const mappings = await port.getAllCurrentMappings();
        for (const mapping of mappings) {
          if (mapping.binding_kind === 'body' && mapping.binding.kind === 'body') {
            semanticToShell.set(mapping.semantic_id, mapping.binding.body_id);
            shellToSemantic.set(mapping.binding.body_id, mapping.semantic_id);
          }
        }

        // Query all 'connected_to' relationships
        const rels = await port.getRelationshipsByKind('connected_to');
        for (const rel of rels) {
          const shellA = semanticToShell.get(rel.sourceId);
          const shellB = semanticToShell.get(rel.targetId);
          if (shellA !== undefined && shellB !== undefined) {
            adjacentPairs.push([shellA, shellB]);
          }
        }
      } catch (err) {
        console.error('Failed to query database metadata for validation:', err);
      }
    }

    // Fallback: If no database metadata was found, or adjacentPairs is empty,
    // and we have multiple parts, we can fall back to treating all pairs of partIds as adjacent
    // to ensure clash checks are still run in non-persistence / testing scenarios.
    if (adjacentPairs.length === 0 && partIds.length > 1) {
      for (let i = 0; i < partIds.length; i++) {
        for (let j = i + 1; j < partIds.length; j++) {
          adjacentPairs.push([partIds[i], partIds[j]]);
        }
      }
    }

    // 4. Construct ValidationContext
    const context: ValidationContext = {
      partIds,
      sheetMetalFlags,
      semanticToShell,
      shellToSemantic,
      adjacentPairs,
    };

    // 5. Execute all rules in parallel
    const errorsList = await Promise.all(
      this.rules.map((rule) => {
        return rule.validate(context).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Wrap rule errors so we don't crash the whole validation
          const ruleErr: ValidationError = {
            id: `err-rule-fail-${rule.name}`,
            category: rule.category,
            severity: 'error',
            message: `Validation rule ${rule.name} failed during execution: ${errMsg}`,
            affected_part_ids: partIds,
          };
          return [ruleErr];
        });
      }),
    );

    // 6. Flatten all errors
    const errors = errorsList.flat();

    // Post-process errors to map C++ shell IDs to Semantic IDs
    for (const error of errors) {
      error.affected_part_ids = error.affected_part_ids.map((id) => {
        return shellToSemantic.get(id) ?? id;
      });
      if (
        error.autofix !== undefined &&
        error.autofix.arguments !== undefined &&
        typeof error.autofix.arguments.part_id === 'string'
      ) {
        const CppId = error.autofix.arguments.part_id;
        error.autofix.arguments.part_id = shellToSemantic.get(CppId) ?? CppId;
      }
    }

    const valid = errors.filter((e) => e.severity === 'error').length === 0;
    const executionTimeMs = Date.now() - startTime;

    return {
      valid,
      errors,
      summary: {
        total_parts_checked: partIds.length,
        rule_count: this.rules.length,
        execution_time_ms: executionTimeMs,
      },
    };
  }
}

// Singleton ValidationEngine instance
export const validationEngine = new ValidationEngine();
