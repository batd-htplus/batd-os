import type { CheckSpec } from "../../contracts/check.ts";
import type { StepDef } from "../../contracts/flow-schema.ts";

export type BriefInput = {
    packInstructions: string;
    step: StepDef;
    goal: string;
    context: string;
    checks: Record<string, CheckSpec>;
    feedback?: string;
};

const describeCheck = (name: string, spec: CheckSpec): string =>
    spec.kind === "command" ? `${name}: \`${spec.run}\` must exit 0` : `${name} (${spec.kind})`;

/** Stable parts first (pack, step), volatile parts last (context, feedback), so engines can cache. */
export function buildBrief(input: BriefInput): string {
    let { step } = input;
    let parts = [input.packInstructions.trim(), `## Step: ${step.id}\n\n${step.instructions.trim()}`];
    let after = (step.checks ?? []).map(name => `- ${describeCheck(name, input.checks[name])}`);
    if (after.length > 0) {
        parts.push(`## Flow will verify after you finish\n\n${after.join("\n")}\n\n` +
            "Do not commit, push, or claim success; Flow runs these checks and records the result.");
    }
    let available = Object.entries(input.checks).filter(([, spec]) => spec.kind === "command")
        .map(([name, spec]) => `- ${describeCheck(name, spec)}`);
    if (available.length > 0) parts.push(`## Checks available in this project\n\n${available.join("\n")}`);
    parts.push(`## Task\n\n${input.goal.trim()}`);
    if (input.context.trim() !== "") parts.push(`## Context\n\n${input.context}`);
    if (input.feedback) parts.push(`## Previous attempt did not pass\n\n${input.feedback.trim()}`);
    return parts.filter(part => part !== "").join("\n\n");
}
