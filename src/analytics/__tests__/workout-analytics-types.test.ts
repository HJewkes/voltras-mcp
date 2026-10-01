// Typecheck proof that @voltras/workout-analytics resolves to real types under
// NodeNext (VW-564). Compiled by `npm run typecheck:tests`; if the package ever
// types as `any` again, the expect-error below goes unused and typecheck fails.

import { describe, expectTypeOf, it } from 'vitest';
import { EMPTY_PHASE, getPhaseDuration, type Phase } from '@voltras/workout-analytics';

describe('workout-analytics typings', () => {
  it('exports typed values rather than any', () => {
    expectTypeOf(EMPTY_PHASE).not.toBeAny();
    expectTypeOf(getPhaseDuration).parameter(0).toEqualTypeOf<Phase>();
    expectTypeOf(getPhaseDuration).returns.toEqualTypeOf<number>();
  });

  it('rejects a call with the wrong argument shape', () => {
    expectTypeOf(getPhaseDuration).toBeCallableWith(EMPTY_PHASE);
    // @ts-expect-error a duration string is not a Phase
    expectTypeOf(getPhaseDuration).toBeCallableWith('1200ms');
  });
});
