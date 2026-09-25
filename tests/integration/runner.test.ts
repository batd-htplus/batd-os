import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ProjectConfig, WorkflowDef } from "../../src/contracts/flow-schema.ts";
import { CliGit } from "../../src/adapters/git/git.ts";
import { NodeProcessRunner } from "../../src/adapters/shell/process-runner.ts";
import { Ledger } from "../../src/kernel/ledger/ledger.ts";
import { reduce } from "../../src/kernel/task/state.ts";
import { createTask, taskDir } from "../../src/kernel/task/task.ts";
import { checkRegistry, loadPack, loadWorkflow } from "../../src/kernel/workflow/load.ts";
import { advance, resolveApproval, type RunnerDeps } from "../../src/kernel/workflow/runner.ts";
import { FakeEngine, tempDir, tempRepo, type Script } from "../helpers.ts";

const HOME = resolve(import.meta.dirname, "..", "..");
const PLAN = 'Plan: create ok.txt.\n```json\n{"items":[{"id":"AC-001","statement":"ok.txt exists","source":"task","verify_by":["test"]}]}\n```';

function setup(script: Script, options: { workflow?: WorkflowDef; config?: ProjectConfig } = {}) {
    let repo = tempRepo();
    let paths = { repo, flowDir: join(repo, ".flow") };
    let git = new CliGit();
    let config: ProjectConfig = { defaultEngine: "fake", checks: { test: { kind: "command", run: "test -f ok.txt" } },
        ...options.config };
    let pack = loadPack(join(HOME, "packs", "core"));
    let checks = checkRegistry(pack.def, config);
    let workflowFile = join(HOME, "flows", "coding.json");
    if (options.workflow) {
        workflowFile = join(tempDir(), "wf.json");
        writeFileSync(workflowFile, JSON.stringify(options.workflow));
    }
    let workflow = loadWorkflow(workflowFile, checks);
    let { taskId, ledger } = createTask(paths, git, workflow.id, "create ok.txt for the signup check");
    let engine = new FakeEngine(script);
    let deps: RunnerDeps = { ledger, taskDir: taskDir(paths, taskId), workflow, checks, packInstructions: pack.instructions,
        config, engines: { fake: engine }, git, processes: new NodeProcessRunner() };
    return { deps, ledger, engine, paths, taskId, state: () => reduce(ledger.events())! };
}

const writeOk = (worktree: string) => writeFileSync(join(worktree, "ok.txt"), "ok\n");

test("coding flow: plan, approval, failed check, retry with feedback, barrier commit, done", async () => {
    let { deps, ledger, engine, state } = setup(req => {
        if (req.stepId === "plan") return { output: PLAN };
        if (req.attempt === 2) writeOk(req.workingDirectory);
    });

    let s = await advance(deps);
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.pendingApproval?.subject, "step");
    assert.ok(existsSync(join(deps.taskDir, "artifacts", "plan.md")));
    assert.ok(existsSync(join(deps.taskDir, "artifacts", "acceptance.json")));
    assert.equal(engine.requests[0].policy.edit, false);

    resolveApproval(ledger, true, "tester");
    s = await advance(deps);
    assert.equal(s.status, "done");
    assert.equal(s.steps.implement.attempt, 2);
    assert.equal(s.costUsd.toFixed(2), "0.30");

    let [, first, second] = engine.requests;
    assert.equal(first.policy.edit, true);
    assert.deepEqual(first.policy.exec, ["test -f ok.txt"]);
    assert.match(first.prompt, /<context id="plan"/);
    assert.doesNotMatch(first.prompt, /Previous attempt/);
    assert.match(second.prompt, /Previous attempt did not pass[\s\S]*test -f ok\.txt/);

    let commit = s.steps.implement.commit!;
    assert.match(commit, /^[0-9a-f]{40}$/);
    let files = execFileSync("git", ["show", "--name-only", "--format=", commit], { cwd: state().worktree, encoding: "utf8" });
    assert.equal(files.trim(), "ok.txt");
    let types = ledger.events().map(e => e.type);
    assert.ok(types.includes("CheckFailed") && types.includes("StepRetry") && types.includes("BarrierCommitted"));
    assert.equal(types.at(-1), "TaskCompleted");
});

test("rejecting with a note redoes the step with the note as feedback", async () => {
    let { deps, ledger, engine } = setup(() => ({ output: PLAN }));
    await advance(deps);
    resolveApproval(ledger, false, "tester", "cover the empty-email case");
    let s = await advance(deps);
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.steps.plan.attempt, 2);
    assert.match(engine.requests[1].prompt, /Reviewer rejected: cover the empty-email case/);

    resolveApproval(ledger, false, "tester");
    assert.equal((await advance(deps)).status, "failed");
});

const oneStep = (retry: number): WorkflowDef => ({ id: "one", version: 1, steps: [
    { id: "build", instructions: "make ok.txt", checks: ["test"], retry, permissions: { edit: true } },
] });

test("exhausted retries wait for a human, and approval grants another round", async () => {
    let calls = 0;
    let { deps, ledger } = setup(req => { if (++calls === 3) writeOk(req.workingDirectory); }, { workflow: oneStep(1) });
    let s = await advance(deps);
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.pendingApproval?.subject, "retries");
    assert.match(s.pendingApproval!.reason, /failed after 2 attempt/);
    resolveApproval(ledger, true, "tester");
    s = await advance(deps);
    assert.equal(s.status, "done");
    assert.equal(s.steps.build.attempt, 3);
});

test("a Flow crash while the engine ran resumes the same attempt from the ledger", async () => {
    let { deps, ledger, engine } = setup(req => writeOk(req.workingDirectory), { workflow: oneStep(0) });
    ledger.append("StepStarted", { attempt: 1 }, "build");
    ledger.append("EngineStarted", { engine: "fake", attempt: 1 }, "build");
    // A new process: fresh ledger handle on the same file.
    let s = await advance({ ...deps, ledger: new Ledger(deps.taskDir, ledger.taskId) });
    assert.equal(s.status, "done");
    assert.equal(engine.requests.length, 1);
    assert.equal(engine.requests[0].attempt, 1);
});

test("changing protected config pauses for approval before checks run", async () => {
    let { deps, ledger } = setup(req => {
        writeOk(req.workingDirectory);
        writeFileSync(join(req.workingDirectory, "eslint.config.js"), "export default [];\n");
    }, { workflow: oneStep(0) });
    let s = await advance(deps);
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.pendingApproval?.subject, "policy:write:eslint.config.js");
    assert.ok(!ledger.events().some(e => e.type === "CheckStarted"));
    resolveApproval(ledger, true, "tester");
    assert.equal((await advance(deps)).status, "done");
});

test("a spent task budget asks before running the engine again", async () => {
    let { deps, engine } = setup(() => {}, { workflow: oneStep(3), config: { budget: { taskUsd: 0.15 } } });
    let s = await advance(deps);
    assert.equal(s.status, "awaiting_approval");
    assert.equal(s.pendingApproval?.subject, "budget");
    assert.equal(engine.requests.length, 2);
    assert.ok(engine.requests[1].maxBudgetUsd! <= 0.05 + 1e-9);
});

test("unknown checks are rejected when the workflow loads", () => {
    let file = join(tempDir(), "bad.json");
    writeFileSync(file, JSON.stringify({ id: "x", version: 1, steps: [{ id: "a", instructions: "i", checks: ["nope"] }] }));
    assert.throws(() => loadWorkflow(file, {}), /unknown check "nope"/);
    assert.ok(readFileSync(join(HOME, "flows", "bugfix.json"), "utf8").includes("regression test"));
});
