#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../../contracts/flow-schema.ts";
import { acquireWriter, Ledger } from "../../kernel/ledger/ledger.ts";
import type { TaskState } from "../../kernel/task/state.ts";
import { createTask, ensureFlowDir, listTasks, loadTask, taskDir } from "../../kernel/task/task.ts";
import { resolveApproval } from "../../kernel/workflow/runner.ts";
import { compose, runTask, type App } from "../compose.ts";
import { serveStdio } from "../mcp-server/server.ts";

const USAGE = `Usage:
  flow init                          create .flow/config.json with detected checks
  flow run <workflow> "<goal>"       create a task and run it (workflows: coding, bugfix)
  flow resume <task|last>            continue a task from its ledger
  flow status [task|last]            show task state
  flow list                          list tasks
  flow approve <task|last> [note]    approve the pending decision and continue
  flow reject <task|last> [note]     reject; with a note the step is redone, without it the task fails
  flow mcp                           serve Flow's MCP tools on stdio`;

const log = (message: string) => process.stderr.write(`flow: ${message}\n`);

function resolveTaskId(app: App, id: string | undefined): string {
    if (id !== undefined && id !== "last") return id;
    let tasks = listTasks(app.paths);
    if (tasks.length === 0) throw new Error("no tasks yet; start one with `flow run`");
    return tasks.at(-1)!.id;
}

function detectChecks(repo: string): ProjectConfig["checks"] {
    let pkg = join(repo, "package.json");
    if (existsSync(pkg)) {
        let scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
        let runner = existsSync(join(repo, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(repo, "yarn.lock")) ? "yarn" : "npm";
        let checks: NonNullable<ProjectConfig["checks"]> = {};
        for (let name of ["test", "lint", "typecheck"]) {
            if (scripts[name]) checks[name] = { kind: "command", run: `${runner} ${name === "test" ? "test" : `run ${name}`}` };
        }
        if (Object.keys(checks).length > 0) return checks;
    }
    if (["pyproject.toml", "pytest.ini", "setup.cfg"].some(f => existsSync(join(repo, f)))) {
        return { test: { kind: "command", run: "pytest -q" } };
    }
    return { test: { kind: "command", run: "echo 'set the test command in .flow/config.json' && exit 1" } };
}

function printState(state: TaskState): void {
    let lines = [
        `task      ${state.id}`,
        `workflow  ${state.workflow}   status ${state.status}   cost $${state.costUsd.toFixed(2)}`,
        `goal      ${state.goal}`,
        `worktree  ${state.worktree} (branch ${state.branch})`,
    ];
    for (let step of Object.values(state.steps)) {
        lines.push(`  ${step.id.padEnd(12)} ${step.phase.padEnd(12)} attempt ${step.attempt}` +
            (step.commit ? `  commit ${step.commit.slice(0, 10)}` : ""));
    }
    if (state.pendingApproval) {
        lines.push(`awaiting approval (${state.pendingApproval.subject}) on ${state.pendingApproval.stepId}:`,
            ...state.pendingApproval.reason.split("\n").slice(0, 20).map(l => `  ${l}`),
            `→ flow approve ${state.id}   |   flow reject ${state.id} "<what to change>"`);
    }
    if (state.failure) lines.push(`failed: ${state.failure}`);
    process.stdout.write(lines.join("\n") + "\n");
}

async function main(argv: string[]): Promise<number> {
    let [command, ...rest] = argv;
    if (command === undefined || command === "help" || command === "--help") {
        process.stdout.write(USAGE + "\n");
        return 0;
    }
    if (command === "mcp") {
        await serveStdio(process.cwd());
        return 0;
    }
    let app = compose(process.cwd());
    switch (command) {
        case "init": {
            ensureFlowDir(app.paths.flowDir);
            let file = join(app.paths.flowDir, "config.json");
            if (existsSync(file)) {
                log(`${file} already exists`);
                return 0;
            }
            let config: ProjectConfig = { defaultEngine: "claude-code", checks: detectChecks(app.paths.repo),
                budget: { taskUsd: 5 } };
            writeFileSync(file, JSON.stringify(config, null, 4) + "\n");
            log(`wrote ${file}; review its checks, then: flow run coding "<goal>"`);
            return 0;
        }
        case "run": {
            let [workflow, ...goalWords] = rest;
            let goal = goalWords.join(" ").trim();
            if (!workflow || !goal) throw new Error('usage: flow run <workflow> "<goal>"');
            let { taskId } = createTask(app.paths, app.git, workflow, goal);
            log(`task ${taskId}`);
            printState(await runTask(app, taskId, workflow, log));
            return 0;
        }
        case "resume": {
            let state = loadTask(app.paths, resolveTaskId(app, rest[0]));
            printState(await runTask(app, state.id, state.workflow, log));
            return 0;
        }
        case "approve":
        case "reject": {
            let taskId = resolveTaskId(app, rest[0]);
            let note = rest.slice(1).join(" ").trim() || undefined;
            let dir = taskDir(app.paths, taskId);
            let release = acquireWriter(dir);
            try {
                resolveApproval(new Ledger(dir, taskId), command === "approve", process.env.USER ?? "human", note);
            } finally {
                release();
            }
            let state = loadTask(app.paths, taskId);
            printState(await runTask(app, taskId, state.workflow, log));
            return 0;
        }
        case "status":
            printState(loadTask(app.paths, resolveTaskId(app, rest[0])));
            return 0;
        case "list":
            for (let state of listTasks(app.paths)) {
                process.stdout.write(`${state.id}  ${state.status.padEnd(17)} ${state.workflow.padEnd(8)} ${state.goal}\n`);
            }
            return 0;
        default:
            process.stderr.write(USAGE + "\n");
            return 2;
    }
}

main(process.argv.slice(2)).then(code => process.exit(code), (err: Error) => {
    log(err.message);
    process.exit(1);
});
