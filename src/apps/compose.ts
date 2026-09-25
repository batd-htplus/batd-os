import { join, resolve } from "node:path";
import type { CheckSpec } from "../contracts/check.ts";
import type { CodingEngine } from "../contracts/engine.ts";
import type { ProjectConfig } from "../contracts/flow-schema.ts";
import { CliGit } from "../adapters/git/git.ts";
import { NodeProcessRunner } from "../adapters/shell/process-runner.ts";
import { ClaudeCodeEngine } from "../engines/claude-code/engine.ts";
import { acquireWriter, Ledger } from "../kernel/ledger/ledger.ts";
import { taskDir, type FlowPaths } from "../kernel/task/task.ts";
import { checkRegistry, findWorkflow, loadConfig, loadPack, loadWorkflow, type LoadedPack } from "../kernel/workflow/load.ts";
import { advance } from "../kernel/workflow/runner.ts";
import type { TaskState } from "../kernel/task/state.ts";

/** Flow's install directory (holds the built-in flows/ and packs/). */
export const FLOW_HOME = resolve(import.meta.dirname, "..", "..");

export type App = {
    paths: FlowPaths;
    git: CliGit;
    processes: NodeProcessRunner;
    engines: Record<string, CodingEngine>;
    config: ProjectConfig;
    pack: LoadedPack;
    checks: Record<string, CheckSpec>;
};

export function compose(cwd: string): App {
    let git = new CliGit();
    if (!git.isRepo(cwd)) throw new Error(`${cwd} is not inside a git repository`);
    let repo = git.topLevel(cwd);
    let paths = { repo, flowDir: join(repo, ".flow") };
    let processes = new NodeProcessRunner();
    let config = loadConfig(paths.flowDir);
    let pack = loadPack(join(FLOW_HOME, "packs", "core"));
    let engines: Record<string, CodingEngine> = { "claude-code": new ClaudeCodeEngine(processes) };
    return { paths, git, processes, engines, config, pack, checks: checkRegistry(pack.def, config) };
}

/** Advances a task under its single-writer lock. */
export async function runTask(app: App, taskId: string, workflowName: string,
    log: (message: string) => void): Promise<TaskState> {
    let dir = taskDir(app.paths, taskId);
    let release = acquireWriter(dir);
    try {
        let workflow = loadWorkflow(findWorkflow(workflowName, app.paths.flowDir, join(FLOW_HOME, "flows")), app.checks);
        return await advance({
            ledger: new Ledger(dir, taskId), taskDir: dir, workflow, checks: app.checks,
            packInstructions: app.pack.instructions, config: app.config, engines: app.engines,
            git: app.git, processes: app.processes, log,
        });
    } finally {
        release();
    }
}
