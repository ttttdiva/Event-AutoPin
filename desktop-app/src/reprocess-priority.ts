import {
  applyEventPatchToLatest,
  type CircleIdentity,
  type CircleIdentityPatch,
} from "./state/event-write-coordinator";

/** 再処理中の優先度変更を、非同期で戻る商品データとは独立して保持する。 */
export class ReprocessPriorityEdits {
  private readonly edits = new Map<string, CircleIdentityPatch>();
  revision = 0;

  record(circleIndex: number, identity: CircleIdentity, priority: number): void {
    const key = JSON.stringify([identity.name, identity.penname, identity.space, identity.hall]);
    this.edits.set(key, {
      circleIndex,
      circleIdentity: { ...identity },
      changes: { priority_color: priority },
    });
    this.revision += 1;
  }

  apply<T extends { circles?: unknown[] }>(data: T): T {
    if (!this.edits.size) return data;
    return applyEventPatchToLatest(data, { circlePatches: [...this.edits.values()] }).data;
  }

  clear(): void {
    this.edits.clear();
    this.revision = 0;
  }
}
