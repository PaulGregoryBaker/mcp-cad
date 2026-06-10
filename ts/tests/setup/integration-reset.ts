import { beforeAll, afterAll } from 'vitest';

import { session } from '../../src/geometry/session';
import { transactionRegistry } from '../../src/mcp/transactions';
import { validationEngine } from '../../src/validation/validator';
import { geometryBinding } from '../../src/geometry/binding';
import { resetMcpGraphStateForTests } from '../../src/mcp/tools';

function resetProcessScopedState(): void {
  transactionRegistry.reset();
  session.reset();
  validationEngine.reset();
  resetMcpGraphStateForTests();

  try {
    geometryBinding.clearSnapshots();
  } catch {
    // Best effort: some mocked bindings in tests do not provide clearSnapshots.
  }
}

// Per-file isolation: clear state before and after each test file.
// Do NOT clear before each test, because several integration files intentionally
// create baseline bodies in their own beforeAll and reuse them across tests.
beforeAll(() => {
  resetProcessScopedState();
});

afterAll(() => {
  resetProcessScopedState();
});
