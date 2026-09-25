import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "../../contracts/infra.ts";
import { Ledger, readLedger } from "../ledger/ledger.ts";
import { reduce, type TaskState } from "./state.ts";

export type FlowPaths = { repo: string; flowDir: string };

export const taskDir = (paths: FlowPaths, taskId: string): string => join(paths.flowDir, "tasks", taskId);

/** Creates .flow/ with a .gitignore for the disposable parts. */
export function ensureFlowDir(flowDir: string): void {
    mkdirSync(join(flowDir, "tasks"), { recursive: true });
    let ignore = join(flowDir, ".gitignore");
    if (!existsSync(ignore)) {
        writeFileSync(ignore, "worktrees/\ncache/\nsnapshot/\ntasks/*/writer.lock\ntasks/*/artifacts/engine/\n");
    }
}

function newTaskId(goal: string, now: Date): string {
    let stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let slug = goal.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/đ/g, "d")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        .slice(0, 24).replace(/-$/, "");
    return `${stamp}-${slug || "task"}`;
}

export function createTask(paths: FlowPaths, git: Git, workflow: string, goal: string,
    now = new Date()): { taskId: string; ledger: Ledger } {
    ensureFlowDir(paths.flowDir);
    let taskId = newTaskId(goal, now);
    for (let n = 2; existsSync(taskDir(paths, taskId)); n++) taskId = `${newTaskId(goal, now)}-${n}`;
    let worktree = join(paths.flowDir, "worktrees", taskId);
    let branch = `flow/${taskId}`;
    let baseCommit = git.head(paths.repo);
    git.addWorktree(paths.repo, worktree, branch, baseCommit);
    let ledger = new Ledger(taskDir(paths, taskId), taskId);
    ledger.append("TaskCreated", { workflow, goal, repo: paths.repo, worktree, branch, baseCommit });
    return { taskId, ledger };
}

export function loadTask(paths: FlowPaths, taskId: string): TaskState {
    let state = reduce(readLedger(taskDir(paths, taskId)));
    if (state === undefined) throw new Error(`No task "${taskId}" in ${join(paths.flowDir, "tasks")}`);
    return state;
}

export function listTasks(paths: FlowPaths): TaskState[] {
    let dir = join(paths.flowDir, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().flatMap(id => {
        let state = reduce(readLedger(join(dir, id)));
        return state === undefined ? [] : [state];
    });
}
