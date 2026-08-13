import { createLoadEpochGuard } from "./event-load-epoch";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function runEventLoadEpochTests(): void {
  const guard = createLoadEpochGuard();
  const first = guard.next();
  const second = guard.next();
  assert(!guard.isCurrent(first), "古い要求は commit できない");
  assert(guard.isCurrent(second), "最新要求だけ commit できる");

  // A delete/memo/status mutation fences a load at start and again at commit;
  // the pre-mutation response must never resurrect the deleted row.
  const inFlightBeforeDelete = guard.next();
  guard.next(); // mutation started
  guard.next(); // mutation committed/local patch applied
  assert(
    !guard.isCurrent(inFlightBeforeDelete),
    "delete commit must prevent old list response resurrection",
  );
}
