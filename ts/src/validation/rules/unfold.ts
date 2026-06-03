import { geometryBinding } from '../../geometry/binding';
import type { ValidationError } from '../../geometry/types';
import type { ValidationContext, ValidationRule } from '../types';

export class UnfoldRule implements ValidationRule {
  readonly name = 'unfold_rule';
  readonly category = 'sheet_metal';

  validate(context: ValidationContext): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    for (const partId of context.partIds) {
      // Default behavior: assume all parts are sheet metal unless explicitly flagged as false
      const isSheetMetal = context.sheetMetalFlags[partId] !== false;
      if (!isSheetMetal) {
        continue;
      }

      try {
        const result = geometryBinding.isPanelValid(partId);
        if (!result.isValid || !result.canFlatten) {
          const detailMsgs = result.errors.map((e) => e.message).join(', ');
          const message = `Part ${partId} failed sheet metal unfold validation${
            detailMsgs ? ': ' + detailMsgs : ''
          }`;

          errors.push({
            id: `err-unfold-${partId}`,
            category: 'sheet_metal',
            severity: 'error',
            message,
            affected_part_ids: [partId],
            autofix: {
              tool_name: 'split_body_by_bends',
              arguments: {
                part_id: partId,
                max_thickness_mm: 5.0,
                default_thickness_mm:
                  result.nominalThicknessMm > 0 ? result.nominalThicknessMm : 1.0,
                max_recursion_depth: 1,
              },
            },
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // If it throws, register the failure as an error
        errors.push({
          id: `err-unfold-fail-${partId}`,
          category: 'sheet_metal',
          severity: 'error',
          message: `Unfold check failed for part ${partId}: ${errMsg}`,
          affected_part_ids: [partId],
        });
      }
    }

    return Promise.resolve(errors);
  }
}
