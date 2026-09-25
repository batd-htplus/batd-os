import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckSpec } from "../../contracts/check.ts";
import type { CodingEngine, EngineResult } from "../../contracts/engine.ts";
import type { ProjectConfig, StepDef, WorkflowDef } from "../../contracts/flow-schema.ts";
import type { Git, ProcessRunner } from "../../contracts/infra.ts";
import { commitBarrier } from "../barrier/barrier.ts";
import { engineCapUsd, maxAttempts, remainingTaskUsd } from "../budget/budget.ts";
import { runCheck } from "../check/checks.ts";
import { discover, refsOf, render, select } from "../context/context.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { auditChanges, decide, type Grants } from "../policy/policy.ts";
import { buildBrief } from "../step/brief.ts";
import { reduce, type ApprovalSubject, type Resolution, type StepState, type TaskState } from "../task/state.ts";

export type RunnerDeps = {
    ledger: Ledger;
    taskDir: string;
    workflow: WorkflowDef;
    checks: Record<string, CheckSpec>;
    packInstructions: string;
    config: ProjectConfig;
    engines: Record<string, CodingEngine>;
    git: Git;
    processes: ProcessRunner;
    log?: (message: string) => void;
};

const DEFAULT_ENGINE = "claude-code";
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NEED_BUDGET = 4000;

/**
 * Drives the task forward until it is done, failed, or waiting for a human. Every decision is taken
 * from the replayed ledger, so calling this again after a crash resumes where the ledger left off.
 */
export async function advance(deps: RunnerDeps): Promise<TaskState> {
    for (;;) {
        let state = reduce(deps.ledger.events())!;
        if (state.status !== "active") return state;
        let step = deps.workflow.steps.find(s => state.steps[s.id]?.phase !== "done");
        if (step === undefined) {
            deps.ledger.append("TaskCompleted", {});
            deps.log?.("task done");
            continue;
        }
        await transition(deps, state, step);
    }
}

/** Records a human answer to the pending approval. */
export function resolveApproval(ledger: Ledger, approved: boolean, by: string, note?: string): void {
    let state = reduce(ledger.events())!;
    if (state.pendingApproval === undefined) throw new Error(`Task ${state.id} is not awaiting approval.`);
    ledger.append("ApprovalResolved", { approved, by, ...(note ? { note } : {}) }, state.pendingApproval.stepId);
}

async function transition(deps: RunnerDeps, state: TaskState, step: StepDef): Promise<void> {
    let st = state.steps[step.id];
    if (st === undefined) return start(deps, step, 1);
    if (st.resolution !== undefined) return resume(deps, state, step, st, st.resolution);
    switch (st.phase) {
        case "retry": return start(deps, step, st.attempt + 1);
        case "started": return runEngine(deps, state, step, st);
        case "engine-done":
        case "checks": return verify(deps, state, step, st);
        case "committed": return finish(deps, step);
        case "failed":
        case "done": return failTask(deps, step, `step ${step.id} is ${st.phase}`);
    }
}

function start(deps: RunnerDeps, step: StepDef, attempt: number): void {
    deps.ledger.append("StepStarted", { attempt }, step.id);
    deps.log?.(`${step.id}: attempt ${attempt}`);
}

async function resume(deps: RunnerDeps, state: TaskState, step: StepDef, st: StepState,
    resolution: Resolution): Promise<void> {
    if (!resolution.approved) {
        if (resolution.note) return retryOrAsk(deps, step, st, `Reviewer rejected: ${resolution.note}`, true);
        return failTask(deps, step, `rejected: ${resolution.reason}`);
    }
    switch (resolution.subject) {
        case "step":
            deps.ledger.append("StepCompleted", {}, step.id);
            return;
        case "retries":
            return retryOrAsk(deps, step, st, resolution.reason, true);
        case "budget":
            return runEngine(deps, state, step, st);
        default:
            return verify(deps, state, step, st);
    }
}

function grants(state: TaskState, step: StepDef, st: StepState, exec: string[]): Grants {
    return { worktree: state.worktree, exec, network: step.permissions?.network ?? false, approved: st.approved };
}

function execAllowlist(step: StepDef, checks: Record<string, CheckSpec>): string[] {
    let fromChecks = (step.checks ?? []).map(name => checks[name])
        .flatMap(spec => spec.kind === "command" ? [spec.run] : []);
    return [...new Set([...(step.permissions?.exec ?? []), ...fromChecks])];
}

async function runEngine(deps: RunnerDeps, state: TaskState, step: StepDef, st: StepState): Promise<void> {
    let { ledger } = deps;
    let remaining = remainingTaskUsd(state, deps.config);
    if (remaining !== undefined && remaining <= 0) {
        return requestApproval(deps, step, "budget", `task spent $${state.costUsd.toFixed(2)}, its budget is used up`);
    }
    let engineId = step.engine ?? deps.config.defaultEngine ?? DEFAULT_ENGINE;
    let engine = deps.engines[engineId];
    if (engine === undefined) return failTask(deps, step, `engine "${engineId}" is not available`);

    let exec = execAllowlist(step, deps.checks);
    for (let command of exec) {
        let decision = decide({ effect: "exec", command }, grants(state, step, st, exec));
        if (decision.decision === "deny") return failTask(deps, step, `policy: ${decision.reason}`);
    }

    let artifactsDir = join(deps.taskDir, "artifacts");
    let needs = step.needs ?? {};
    let items;
    try {
        items = discover(needs, { git: deps.git, worktree: state.worktree, artifactsDir, goal: state.goal });
    } catch (err) {
        return failTask(deps, step, `context: ${(err as Error).message}`);
    }
    let totalBudget = Object.values(needs).reduce((sum, need) => sum + (need.budget ?? DEFAULT_NEED_BUDGET), 0);
    let { selected } = select(items, totalBudget);
    for (let item of selected) {
        let previous = state.context[item.id];
        if (previous !== undefined && previous !== item.hash && item.id !== "repo") {
            ledger.append("ContextInvalidated", { item: item.id, oldHash: previous, newHash: item.hash }, step.id);
        }
    }
    ledger.append("ContextLoaded", {
        items: refsOf(selected), totalTokens: selected.reduce((sum, item) => sum + item.tokens, 0),
    }, step.id);

    let prompt = buildBrief({
        packInstructions: deps.packInstructions, step, goal: state.goal, checks: deps.checks,
        context: render(selected.filter(item => item.id !== "task")), feedback: st.feedback,
    });
    ledger.append("EngineStarted", { engine: engineId, attempt: st.attempt }, step.id);
    deps.log?.(`${step.id}: running ${engineId}`);

    let result: EngineResult;
    try {
        result = await engine.run({
            taskId: state.id, stepId: step.id, attempt: st.attempt, workingDirectory: state.worktree, prompt,
            timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
            policy: { edit: step.permissions?.edit ?? false, exec, network: step.permissions?.network ?? false },
            maxBudgetUsd: engineCapUsd(step, state, deps.config), model: deps.config.model,
            artifactDir: join(artifactsDir, "engine"),
        });
    } catch (err) {
        result = { status: "error", exitCode: -1, durationMs: 0, output: "", outputArtifact: "", usage: {},
            error: (err as Error).message };
    }
    let changedFiles = deps.git.changedFiles(state.worktree);

    if (result.status !== "success") {
        ledger.append("EngineFailed", {
            engine: engineId, error: result.error ?? result.status, durationMs: result.durationMs,
            ...(result.outputArtifact ? { outputArtifact: result.outputArtifact } : {}),
        }, step.id);
        return retryOrAsk(deps, step, st, `The ${engineId} run ended with ${result.status}: ${result.error ?? ""}`);
    }
    if (step.output !== undefined) {
        mkdirSync(artifactsDir, { recursive: true });
        writeFileSync(join(artifactsDir, step.output), result.output);
        ledger.append("EvidenceCreated", { kind: "output", artifact: `artifacts/${step.output}` }, step.id);
    }
    ledger.append("EngineCompleted", {
        engine: engineId, exitCode: result.exitCode, durationMs: result.durationMs,
        outputArtifact: result.outputArtifact, changedFiles, ...result.usage,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    }, step.id);
    deps.log?.(`${step.id}: ${engineId} finished, ${changedFiles.length} file(s) changed`);
}

async function verify(deps: RunnerDeps, state: TaskState, step: StepDef, st: StepState): Promise<void> {
    let { ledger } = deps;
    let audit = auditChanges(st.changedFiles, grants(state, step, st, execAllowlist(step, deps.checks)));
    if (audit.decision === "deny") return retryOrAsk(deps, step, st, `Policy: ${audit.reason}. Revert that change.`);
    if (audit.decision === "ask") return requestApproval(deps, step, audit.subject as ApprovalSubject, audit.reason);

    let passed: string[] = [];
    let failures: string[] = [];
    for (let name of step.checks ?? []) {
        ledger.append("CheckStarted", { check: name }, step.id);
        let result = await runCheck(name, deps.checks[name], {
            runner: deps.processes, worktree: state.worktree, artifactsDir: join(deps.taskDir, "artifacts"),
            passed, logName: `${step.id}-${st.attempt}-${name}`, taskDir: deps.taskDir,
        });
        if (result.pass) {
            ledger.append("CheckPassed", { check: name, evidence: result.evidence }, step.id);
            passed.push(name);
        } else {
            ledger.append("CheckFailed", { check: name, evidence: result.evidence, reasons: result.reasons }, step.id);
            failures.push(...result.reasons.map(r => `[${name}] ${r.rule}\n${r.fix}`));
        }
        deps.log?.(`${step.id}: check ${name} ${result.pass ? "passed" : "FAILED"}`);
    }
    if (failures.length > 0) {
        let feedback = failures.join("\n\n");
        let noProgress = noProgressReason(step, st, feedback);
        if (noProgress !== undefined) {
            return requestApproval(deps, step, "retries", `${noProgress}; retrying would repeat it:\n${feedback}`);
        }
        return retryOrAsk(deps, step, st, feedback);
    }
    try {
        commitBarrier(ledger, deps.git, state.worktree, step.id, st.attempt);
    } catch (err) {
        return retryOrAsk(deps, step, st, `Committing the step failed: ${(err as Error).message}`);
    }
}

function finish(deps: RunnerDeps, step: StepDef): void {
    if (step.approval) {
        let what = step.output ? `artifacts/${step.output}` : "the committed changes";
        return requestApproval(deps, step, "step", `review ${what} before the workflow continues`);
    }
    deps.ledger.append("StepCompleted", {}, step.id);
}

// Timings and counters differ between otherwise identical failures.
const failureShape = (text: string): string => text.replace(/\d+(\.\d+)?/g, "#");

/**
 * Why another attempt would only repeat this one, or undefined when a retry can make progress:
 * an editing step whose engine changed nothing, or the same failure as the previous attempt.
 */
function noProgressReason(step: StepDef, st: StepState, feedback: string): string | undefined {
    if (step.permissions?.edit && st.changedFiles.length === 0) return "the engine changed no files";
    if (st.feedback !== undefined && failureShape(st.feedback) === failureShape(feedback)) {
        return "the check failed the same way as the previous attempt";
    }
    return undefined;
}

/** Another attempt while the step has attempts left; otherwise a human decides. */
function retryOrAsk(deps: RunnerDeps, step: StepDef, st: StepState, reason: string, granted = false): void {
    if (granted || st.attempt < maxAttempts(step, st)) {
        deps.ledger.append("StepRetry", { attempt: st.attempt + 1, reason }, step.id);
        return;
    }
    requestApproval(deps, step, "retries", `failed after ${st.attempt} attempt(s):\n${reason}`);
}

function requestApproval(deps: RunnerDeps, step: StepDef, subject: ApprovalSubject, reason: string): void {
    deps.ledger.append("ApprovalRequested", { reason, subject }, step.id);
    deps.ledger.append("StepAwaitingApproval", { reason }, step.id);
    deps.log?.(`${step.id}: awaiting approval (${subject}): ${reason.split("\n")[0]}`);
}

function failTask(deps: RunnerDeps, step: StepDef, reason: string): void {
    deps.ledger.append("StepFailed", { reason }, step.id);
    deps.ledger.append("TaskFailed", { reason });
    deps.log?.(`${step.id}: task failed: ${reason}`);
}
