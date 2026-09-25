import type { FlowEvent } from "../../contracts/events.ts";

/** Where a step is inside one attempt. */
export type StepPhase =
    | "started"      // attempt began; engine not finished (or Flow crashed while it ran)
    | "engine-done"  // engine finished; changes not yet audited/checked
    | "checks"       // checks running (or interrupted)
    | "committed"    // checks passed and the barrier committed
    | "retry"        // attempt failed; next attempt not started yet
    | "done"
    | "failed";

/** What a pending approval is about; decides how the runner resumes. */
export type ApprovalSubject = "step" | "retries" | "budget" | `policy:${string}`;

export type Resolution = { subject: ApprovalSubject; reason: string; approved: boolean; note?: string };

export type StepState = {
    id: string;
    phase: StepPhase;
    attempt: number;
    /** Extra attempts granted by approving "retries". */
    extraAttempts: number;
    feedback?: string;
    changedFiles: string[];
    engineOutputArtifact?: string;
    commit?: string | null;
    /** Policy subjects a human already approved for this step. */
    approved: string[];
    /** Checks that passed in the current attempt. */
    passedChecks: string[];
    /** An approval answered but not yet acted on. */
    resolution?: Resolution;
};

export type TaskState = {
    id: string;
    workflow: string;
    goal: string;
    repo: string;
    worktree: string;
    branch: string;
    baseCommit: string;
    status: "active" | "awaiting_approval" | "done" | "failed";
    failure?: string;
    steps: Record<string, StepState>;
    pendingApproval?: { stepId: string; subject: ApprovalSubject; reason: string };
    costUsd: number;
    /** Times a human approved going over the task budget; each grants one more budget. */
    budgetGrants: number;
    context: Record<string, string>;
    lastSeq: number;
};

function newStep(id: string): StepState {
    return { id, phase: "started", attempt: 0, extraAttempts: 0, changedFiles: [], approved: [],
        passedChecks: [] };
}

export function reduce(events: FlowEvent[]): TaskState | undefined {
    let state: TaskState | undefined;
    for (let event of events) {
        if (event.type === "TaskCreated") {
            state = {
                id: event.taskId, ...event.data, status: "active", steps: {}, costUsd: 0,
                budgetGrants: 0, context: {}, lastSeq: event.seq,
            };
            continue;
        }
        if (state === undefined) throw new Error("Ledger does not start with TaskCreated.");
        state.lastSeq = event.seq;
        let step = event.stepId === undefined ? undefined
            : (state.steps[event.stepId] ??= newStep(event.stepId));

        // Any later event for the step means the runner acted on the last approval answer.
        if (step !== undefined && event.type !== "ApprovalResolved") step.resolution = undefined;

        switch (event.type) {
            case "StepStarted":
                step!.phase = "started";
                step!.attempt = event.data.attempt;
                step!.passedChecks = [];
                break;
            case "EngineCompleted":
                step!.phase = "engine-done";
                step!.changedFiles = event.data.changedFiles;
                step!.engineOutputArtifact = event.data.outputArtifact;
                state.costUsd += event.data.costUsd ?? 0;
                break;
            case "CheckStarted":
                step!.phase = "checks";
                break;
            case "CheckPassed":
                step!.passedChecks.push(event.data.check);
                break;
            case "BarrierCommitted":
                step!.phase = "committed";
                step!.commit = event.data.commitSha;
                break;
            case "StepRetry":
                step!.phase = "retry";
                step!.feedback = event.data.reason;
                break;
            case "ApprovalRequested":
                state.pendingApproval = {
                    stepId: event.stepId!, subject: event.data.subject as ApprovalSubject,
                    reason: event.data.reason,
                };
                break;
            case "StepAwaitingApproval":
                state.status = "awaiting_approval";
                break;
            case "ApprovalResolved": {
                let pending = state.pendingApproval;
                if (pending !== undefined) {
                    let target = state.steps[pending.stepId];
                    target.resolution = { subject: pending.subject, reason: pending.reason, ...event.data };
                    if (event.data.approved) {
                        if (pending.subject === "retries") target.extraAttempts += 1;
                        if (pending.subject === "budget") state.budgetGrants += 1;
                        if (pending.subject.startsWith("policy:")) target.approved.push(pending.subject);
                    }
                }
                state.pendingApproval = undefined;
                state.status = "active";
                break;
            }
            case "StepCompleted":
                step!.phase = "done";
                step!.feedback = undefined;
                break;
            case "StepFailed":
                step!.phase = "failed";
                break;
            case "ContextLoaded":
                for (let item of event.data.items) state.context[item.id] = item.hash;
                break;
            case "ContextInvalidated":
                state.context[event.data.item] = event.data.newHash;
                break;
            case "TaskCompleted":
                state.status = "done";
                break;
            case "TaskFailed":
                state.status = "failed";
                state.failure = event.data.reason;
                break;
        }
    }
    return state;
}
