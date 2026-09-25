import type { CheckSpec } from "./check.ts";

/** A context requirement: `repo`, `task`, a previous step's artifact name, or `file:<path>`. */
export type NeedSpec = {
    /** Token cap for this source (estimate: chars / 4). */
    budget?: number;
    /** Search terms for `repo`; defaults to words from the task goal. */
    search?: string[];
};

export type StepDef = {
    id: string;
    engine?: string;
    /** Instructions for this step, appended after the pack instructions. */
    instructions: string;
    needs?: Record<string, NeedSpec>;
    /** Save the engine's final answer as artifacts/<output> (e.g. "plan.md"). */
    output?: string;
    checks?: string[];
    approval?: boolean;
    retry?: number;
    timeoutMs?: number;
    budget?: { usd?: number };
    permissions?: { edit?: boolean; exec?: string[]; network?: boolean };
};

export type WorkflowDef = {
    id: string;
    version: number;
    truth?: "requirements" | "current-code" | "legacy";
    steps: StepDef[];
};

/** Project configuration (.flow/config.json). */
export type ProjectConfig = {
    defaultEngine?: string;
    model?: string;
    checks?: Record<string, CheckSpec>;
    budget?: { taskUsd?: number };
};
