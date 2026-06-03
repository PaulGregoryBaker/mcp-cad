import type { ValidationError } from '../geometry/types';

export interface ValidationContext {
  partIds: string[]; // shell IDs of parts to check
  sheetMetalFlags: Record<string, boolean>; // override sheet metal flags
  semanticToShell: Map<string, string>; // semantic entity id -> shell id
  shellToSemantic: Map<string, string>; // shell id -> semantic entity id
  adjacentPairs: [string, string][]; // list of adjacent shell ID pairs
}

export interface ValidationRule {
  name: string;
  category: 'sheet_metal' | 'clash_detection' | 'semantic_graph' | 'manufacturing' | 'nesting';
  validate(context: ValidationContext): Promise<ValidationError[]>;
}
