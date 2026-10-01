/**
 * The `#/body` drill stack as React state (VW-713, VW-339 slice S3): the
 * reducer, the 60 s idle heal and the `#/body/<muscle>` hash, kept in step.
 *
 * The hash and the stack each change on their own (a press, a dismiss or the
 * idle heal moves the stack; the back button or a typed URL moves the hash), so
 * each side is synced only when it is the one that changed. That is what stops
 * the two from chasing each other.
 */
import { useEffect, useMemo, useReducer, useRef, type Dispatch } from 'react';

import { drillStackReducer, type DrillAction, type DrillStack } from '../drill/drill-stack.js';
import type { IdleHeal } from '../drill/idle-heal.js';
import {
  bindIdleHeal,
  bodyDrillHandlers,
  bodyHashFor,
  initialBodyStack,
  syncToRoute,
  undrawableSheetAction,
  type BodyDrillHandlers,
} from './body-drill.js';
import type { BodyPageData } from './body-model.js';

export function useBodyDrill(
  routeMuscle: string | undefined,
  data: BodyPageData | null,
): {
  stack: DrillStack;
  drill: BodyDrillHandlers;
} {
  const [stack, dispatch] = useReducer(drillStackReducer, routeMuscle, initialBodyStack);
  const drill = useMemo(() => bodyDrillHandlers(dispatch), []);
  useIdleHeal(stack.length > 0, dispatch);
  useHashSync(stack, routeMuscle, dispatch);
  useEffect(() => {
    const action = undrawableSheetAction(stack, data);
    if (action !== null) dispatch(action);
  }, [stack, data]);
  return { stack, drill };
}

/** The heal lives and dies with the effect, so no late `setActive` can re-arm it after unmount. */
function useIdleHeal(active: boolean, dispatch: Dispatch<DrillAction>): void {
  const healRef = useRef<IdleHeal | null>(null);
  useEffect(() => {
    const { heal, unbind } = bindIdleHeal(document, dispatch);
    healRef.current = heal;
    return () => {
      unbind();
      healRef.current = null;
    };
  }, [dispatch]);
  useEffect(() => healRef.current?.setActive(active), [active]);
}

function useHashSync(
  stack: DrillStack,
  routeMuscle: string | undefined,
  dispatch: Dispatch<DrillAction>,
): void {
  const stackRef = useRef(stack);
  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  useEffect(() => {
    const action = syncToRoute(stackRef.current, routeMuscle);
    if (action !== null) dispatch(action);
  }, [routeMuscle, dispatch]);
  const hash = bodyHashFor(stack);
  useEffect(() => {
    if (window.location.hash !== hash) window.location.hash = hash;
  }, [hash]);
}
