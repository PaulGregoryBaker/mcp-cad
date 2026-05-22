/**
 * Structured error model for MCP-CAD.
 * All tool errors return { code, message, recoverable, suggested_tool }.
 * Constitution Principle VI: no unstructured throws reach the MCP boundary.
 *
 * Task: T037
 */

// ─── Error codes (from Engineering-Design §3.4) ──────────────────────────────

export const ErrorCodes = {
  // Geometry Engine errors
  GE_IMPORT_FAILED: 'GE_IMPORT_FAILED',
  GE_INVALID_SOLID: 'GE_INVALID_SOLID',
  GE_SOLID_NOT_FOUND: 'GE_SOLID_NOT_FOUND',
  GE_SHELL_NOT_FOUND: 'GE_SHELL_NOT_FOUND',
  GE_UNFOLD_NOT_FOUND: 'GE_UNFOLD_NOT_FOUND',
  GE_HEAL_FAILED: 'GE_HEAL_FAILED',
  GE_BOOLEAN_FAILURE: 'GE_BOOLEAN_FAILURE',
  GE_EMPTY_RESULT: 'GE_EMPTY_RESULT',
  GE_TAB_SLOT_FAILED: 'GE_TAB_SLOT_FAILED',
  GE_UNFOLD_FAILED: 'GE_UNFOLD_FAILED',
  GE_RELIEF_FAILED: 'GE_RELIEF_FAILED',
  GE_NEST_FAILED: 'GE_NEST_FAILED',
  GE_SNAPSHOT_NOT_FOUND: 'GE_SNAPSHOT_NOT_FOUND',
  GE_RESTORE_FAILED: 'GE_RESTORE_FAILED',

  // Manufacturing Domain errors
  MD_MATERIAL_NOT_FOUND: 'MD_MATERIAL_NOT_FOUND',
  MD_SAFETY_VIOLATION: 'MD_SAFETY_VIOLATION',
  MD_RULE_VIOLATION: 'MD_RULE_VIOLATION',

  // Anti-Corruption Layer errors
  ACL_EXTRACTION_FAILED: 'ACL_EXTRACTION_FAILED',

  // Export errors
  EXPORT_JOB_NOT_FOUND: 'EXPORT_JOB_NOT_FOUND',
  EXPORT_JOB_NOT_COMPLETE: 'EXPORT_JOB_NOT_COMPLETE',

  // Config errors
  CONFIG_INVALID: 'CONFIG_INVALID',

  // Gap-closure geometry errors (Feature 002-mcp-tools-gap)
  GE_CLASH_DETECTION_FAILED: 'GE_CLASH_DETECTION_FAILED',
  GE_GAP_DETECTION_FAILED: 'GE_GAP_DETECTION_FAILED',
  GE_TRIM_FAILED: 'GE_TRIM_FAILED',
  GE_SPLIT_FAILED: 'GE_SPLIT_FAILED',
  GE_EXTEND_FAILED: 'GE_EXTEND_FAILED',
  GE_OFFSET_FAILED: 'GE_OFFSET_FAILED',
  GE_FLANGE_FAILED: 'GE_FLANGE_FAILED',
  GE_EDGE_NOT_OPEN: 'GE_EDGE_NOT_OPEN',
  GE_RIP_FAILED: 'GE_RIP_FAILED',
  GE_EDGE_NOT_INTERIOR: 'GE_EDGE_NOT_INTERIOR',
  GE_MERGE_FAILED: 'GE_MERGE_FAILED',
  MD_LOGISTICS_NOT_CONFIGURED: 'MD_LOGISTICS_NOT_CONFIGURED',
  GE_DECOMPOSE_BY_BENDS_FAILED: 'GE_DECOMPOSE_BY_BENDS_FAILED',
  GE_DECOMPOSE_THICKNESS_MISMATCH: 'GE_DECOMPOSE_THICKNESS_MISMATCH',
  GE_DECOMPOSE_EXTRUDE_FAILED: 'GE_DECOMPOSE_EXTRUDE_FAILED',
  GE_DECOMPOSE_CUT_FAILED: 'GE_DECOMPOSE_CUT_FAILED',
  GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED: 'GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED',

  // Transaction primitive errors (Feature 004-transaction-primitive)
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  TRANSACTION_NOT_ACTIVE: 'TRANSACTION_NOT_ACTIVE',
  TRANSACTION_ALREADY_ACTIVE: 'TRANSACTION_ALREADY_ACTIVE',
  TRANSACTION_MISMATCH: 'TRANSACTION_MISMATCH',

  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ─── Structured error type ───────────────────────────────────────────────────

export interface StructuredError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestedTool?: string;
}

// ─── McpToolError — carries a StructuredError as a thrown object ──────────────

export class McpToolError extends Error {
  public readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.structured = structured;
    this.name = 'McpToolError';
  }
}

// ─── Error factories ──────────────────────────────────────────────────────────

export function makeError(
  code: ErrorCode,
  message: string,
  recoverable: boolean,
  suggestedTool?: string,
): StructuredError {
  return { code, message, recoverable, suggestedTool };
}

export function throwError(
  code: ErrorCode,
  message: string,
  recoverable: boolean,
  suggestedTool?: string,
): never {
  throw new McpToolError(makeError(code, message, recoverable, suggestedTool));
}

/**
 * Converts any thrown value (including NAPI errors from the C++ addon)
 * into a StructuredError. Ensures no unstructured throws escape to MCP.
 */
export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof McpToolError) {
    return err.structured;
  }

  // Handle POJO StructuredError recursively passed
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.code === 'string') {
      return {
        code: (errObj.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
        message: String(errObj.message),
        recoverable: Boolean(errObj.recoverable),
        suggestedTool: typeof errObj.suggestedTool === 'string' ? errObj.suggestedTool : undefined,
      };
    }
  }

  if (err instanceof Error) {
    // Try to parse code from NAPI-thrown errors (JSON format in message)
    try {
      const parsed = JSON.parse(err.message) as Record<string, unknown>;
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        return {
          code: (parsed.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
          message: parsed.message as string,
          recoverable: typeof parsed.recoverable === 'boolean' ? parsed.recoverable : false,
          suggestedTool:
            typeof parsed.suggestedTool === 'string' ? parsed.suggestedTool : undefined,
        };
      }
    } catch {
      // Not JSON; fall through
    }

    // Check if error has a code property (from C++ addon)
    // (Unreachable in practice: the object-check above already handles Error+code cases)
    /* v8 ignore next 7 */
    const errWithCode = err as Error & { code?: string };
    if (typeof errWithCode.code === 'string') {
      return {
        code: (errWithCode.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
        message: err.message,
        recoverable: false,
      };
    }

    return {
      code: ErrorCodes.INTERNAL_ERROR,
      message: err.message,
      recoverable: false,
    };
  }

  return {
    code: ErrorCodes.INTERNAL_ERROR,
    message: String(err),
    recoverable: false,
  };
}
