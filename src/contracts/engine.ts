/** Orchestration-level permissions Flow grants a run; the adapter maps them to the CLI's flags. */
export type EnginePolicy = {
    /** May the engine edit files in its working directory? */
    edit: boolean;
    /** Shell commands (prefixes) the engine may run. Empty = no shell. */
    exec: string[];
    /** May the engine reach the network (web fetch/search)? */
    network: boolean;
};

export type EngineRequest = {
    taskId: string;
    stepId: string;
    attempt: number;
    /** The task's worktree; the engine must not write outside it. */
    workingDirectory: string;
    /** The full brief: instructions + selected context + feedback. */
    prompt: string;
    environment?: Record<string, string>;
    timeoutMs: number;
    policy: EnginePolicy;
    /** Remaining spend the engine may use, when the engine supports a cap. */
    maxBudgetUsd?: number;
    model?: string;
    /** Where the adapter stores raw stdout/stderr. */
    artifactDir: string;
};

export type EngineUsage = {
    costUsd?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
};

export type EngineResult = {
    status: "success" | "error" | "timeout";
    exitCode: number;
    durationMs: number;
    /** The engine's final answer text (e.g. a plan), when it produces one. */
    output: string;
    /** Raw transcript/stdout file, relative to the task directory. */
    outputArtifact: string;
    usage: EngineUsage;
    sessionId?: string;
    error?: string;
};

export interface CodingEngine {
    readonly id: string;
    run(request: EngineRequest): Promise<EngineResult>;
}
