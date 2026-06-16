import { beforeAll, afterAll } from 'vitest';

import { session } from '../../src/geometry/session';
import { transactionRegistry } from '../../src/mcp/transactions';
import { validationEngine } from '../../src/validation/validator';
import { geometryBinding } from '../../src/geometry/binding';
import { resetMcpGraphStateForTests } from '../../src/mcp/tools';

function resetState(): void {
  transactionRegistry.reset();
  session.reset();
  validationEngine.reset();
  resetMcpGraphStateForTests();

  try {
    // Full C++ service reset: clears all accumulated OCCT shells, solids, and
    // unfolds that build up over the 37-file sequential singleFork run and cause
    // getPanelFrame to fail for valid flat shells (GE_PANEL_FRAME_FAILED).
    geometryBinding.clearState();
  } catch {
    // Best effort: unit/contract tests use mocked bindings without clearState.
  }
  try {
    geometryBinding.clearSnapshots();
  } catch {
    // Best effort: some mocked bindings in tests do not provide clearSnapshots.
  }
}

// Per-file isolation: fully reset TypeScript + C++ state before each test file.
// clearState() is called only in beforeAll (not afterAll) because calling it on
// a heavily-loaded OCCT service during process-level teardown (after the last
// file) triggers OCCT static destructors in an unsafe order and causes SIGSEGV.
// The OS reclaims all memory on process exit; afterAll clearState is unnecessary.
beforeAll(() => {
  resetState();
});

afterAll(() => {
  // TypeScript-only reset is safe; skip C++ clearState at teardown.
  transactionRegistry.reset();
  session.reset();
  validationEngine.reset();
  resetMcpGraphStateForTests();
});
