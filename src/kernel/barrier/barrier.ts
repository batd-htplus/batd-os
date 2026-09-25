import type { Git } from "../../contracts/infra.ts";
import type { Ledger } from "../ledger/ledger.ts";

/** Makes a step's verified work durable: commit the worktree, then record the commit. */
export function commitBarrier(ledger: Ledger, git: Git, worktree: string, stepId: string, attempt: number): string | null {
    let sha = git.commitAll(worktree, `flow(${ledger.taskId}): ${stepId} (attempt ${attempt})`);
    ledger.append("BarrierCommitted", { commitSha: sha }, stepId);
    return sha;
}
