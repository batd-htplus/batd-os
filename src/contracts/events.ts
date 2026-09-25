export const EVENT_VERSION = 1;

export type ContextItemRef = { id: string; hash: string; tokens: number };

export type CheckEvidence = {
    command?: string;
    exitCode?: number;
    durationMs: number;
    outputArtifact?: string;
};

export type CheckReason = { rule: string; fix: string };

/** Payload of each event type. */
export type EventPayloads = {
    TaskCreated: {
        workflow: string;
        goal: string;
        repo: string;
        worktree: string;
        branch: string;
        baseCommit: string;
    };
    TaskCompleted: {};
    TaskFailed: { reason: string };

    StepStarted: { attempt: number };
    StepCompleted: {};
    StepFailed: { reason: string };
    StepRetry: { attempt: number; reason: string };
    StepAwaitingApproval: { reason: string };

    EngineStarted: { engine: string; attempt: number };
    EngineCompleted: {
        engine: string;
        exitCode: number;
        durationMs: number;
        outputArtifact: string;
        changedFiles: string[];
        costUsd?: number;
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        sessionId?: string;
    };
    EngineFailed: { engine: string; error: string; durationMs: number; outputArtifact?: string };

    ContextLoaded: { items: ContextItemRef[]; totalTokens: number };
    ContextInvalidated: { item: string; oldHash: string; newHash: string };

    ApprovalRequested: { reason: string; subject: string };
    ApprovalResolved: { approved: boolean; by: string; note?: string };

    CheckStarted: { check: string };
    CheckPassed: { check: string; evidence: CheckEvidence };
    CheckFailed: { check: string; evidence: CheckEvidence; reasons: CheckReason[] };

    EvidenceCreated: { kind: string; artifact: string };

    BarrierCommitted: { commitSha: string | null };
};

export type EventType = keyof EventPayloads;

/** One line of events.jsonl. */
export type FlowEvent<T extends EventType = EventType> = {
    [K in T]: {
        v: number;
        seq: number;
        ts: string;
        taskId: string;
        stepId?: string;
        type: K;
        data: EventPayloads[K];
    };
}[T];
