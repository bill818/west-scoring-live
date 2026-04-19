// Phase 0 sanity test — proves Vitest runs.
// Replaced with real module tests as /v3/js/*.js gets filled in.
import { describe, it, expect } from 'vitest';

describe('vitest harness', () => {
  it('runs and assertions work', () => {
    expect(1 + 1).toBe(2);
  });
});
