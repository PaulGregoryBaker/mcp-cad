import { beforeAll, afterAll } from 'vitest';

import { geometryBinding } from '../../src/geometry/binding';

// Per-file isolation: fully reset the C++ service's accumulated state before
// each test file. clearState() is called only in beforeAll (not afterAll)
// because calling it on a heavily-loaded OCCT service during process-level
// teardown (after the last file) triggers OCCT static destructors in an
// unsafe order and causes SIGSEGV. The OS reclaims all memory on process
// exit; afterAll clearState is unnecessary.
beforeAll(() => {
  geometryBinding.clearState();
  geometryBinding.clearSnapshots();
});
