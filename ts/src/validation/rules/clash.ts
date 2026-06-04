import { geometryBinding } from '../../geometry/binding';
import type { ValidationError } from '../../geometry/types';
import type { ValidationContext, ValidationRule } from '../types';

export class ClashRule implements ValidationRule {
  readonly name = 'clash_rule';
  readonly category = 'clash_detection';

  validate(context: ValidationContext): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    if (context.adjacentPairs.length === 0) {
      return Promise.resolve(errors);
    }

    try {
      const clashes = geometryBinding.checkAssemblyClashes(context.partIds, context.adjacentPairs);
      for (let i = 0; i < clashes.length; i++) {
        const cp = clashes[i];

        errors.push({
          id: `err-clash-${cp.partIdA}-${cp.partIdB}`,
          category: 'clash_detection',
          severity: 'error',
          message: `Physical overlap detected between adjacent parts ${cp.partIdA} and ${cp.partIdB} (volume: ${cp.intersectionVolumeMm3.toFixed(2)} mm³)`,
          affected_part_ids: [cp.partIdA, cp.partIdB],
          autofix: {
            tool_name: 'trim_body_with_plane',
            arguments: {
              part_id: cp.partIdB,
              plane: cp.suggestedCuttingPlane,
              keep_positive_side: true,
            },
          },
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({
        id: 'err-clash-fail',
        category: 'clash_detection',
        severity: 'error',
        message: `Clash detection failed: ${errMsg}`,
        affected_part_ids: context.partIds,
      });
    }

    return Promise.resolve(errors);
  }
}
