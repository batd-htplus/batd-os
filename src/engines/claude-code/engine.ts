import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CodingEngine, EngineRequest, EngineResult } from "../../contracts/engine.ts";
import type { ProcessRunner } from "../../contracts/infra.ts";

const READ_TOOLS = ["Read", "Grep", "Glob"];
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];
// Only fixed-shape tokens reach the command line (same guard as ecc/scripts/claw.js).
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The JSON object `claude -p --output-format json` prints. */
type ClaudeJsonResult = {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    session_id?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
};

/** Maps Flow's orchestration policy onto Claude Code's permission flags. */
export function claudeArgs(request: EngineRequest): string[] {
    let { policy } = request;
    let allowed = [
        ...READ_TOOLS,
        ...(policy.edit ? EDIT_TOOLS : []),
        ...(policy.network ? NETWORK_TOOLS : []),
        ...policy.exec.map(command => `Bash(${command}:*)`),
    ];
    let disallowed = [...(policy.edit ? [] : EDIT_TOOLS), ...(policy.network ? [] : NETWORK_TOOLS)];
    let args = [
        "-p", "--output-format", "json",
        // Headless: anything not pre-allowed is denied instead of prompting.
        "--permission-mode", "dontAsk",
        "--allowedTools", ...allowed,
    ];
    if (disallowed.length > 0) args.push("--disallowedTools", ...disallowed);
    if (request.maxBudgetUsd !== undefined) args.push("--max-budget-usd", request.maxBudgetUsd.toFixed(2));
    if (request.model !== undefined) {
        if (!MODEL_PATTERN.test(request.model)) throw new Error(`invalid model name: ${request.model}`);
        args.push("--model", request.model);
    }
    return args;
}

export function parseClaudeOutput(stdout: string): ClaudeJsonResult | undefined {
    let text = stdout.trim();
    try {
        return JSON.parse(text) as ClaudeJsonResult;
    } catch {
        let last = text.split("\n").reverse().find(line => line.startsWith("{"));
        try { return last ? JSON.parse(last) as ClaudeJsonResult : undefined; } catch { return undefined; }
    }
}

export class ClaudeCodeEngine implements CodingEngine {
    readonly id = "claude-code";
    readonly #processes: ProcessRunner;
    readonly #binary: string;

    constructor(processes: ProcessRunner, binary = "claude") {
        this.#processes = processes;
        this.#binary = binary;
    }

    async run(request: EngineRequest): Promise<EngineResult> {
        let result = await this.#processes.run(this.#binary, claudeArgs(request), {
            cwd: request.workingDirectory,
            input: request.prompt,
            // An empty CLAUDECODE lets Claude Code start inside another Claude Code session.
            env: { CLAUDECODE: "", ...request.environment },
            timeoutMs: request.timeoutMs,
        });
        mkdirSync(request.artifactDir, { recursive: true });
        let file = join(request.artifactDir, `${request.stepId}-${request.attempt}.claude.json`);
        writeFileSync(file, result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""));
        let outputArtifact = join("artifacts", basename(request.artifactDir), basename(file));

        let parsed = parseClaudeOutput(result.stdout);
        let usage = {
            ...(parsed?.total_cost_usd !== undefined ? { costUsd: parsed.total_cost_usd } : {}),
            ...(parsed?.usage?.input_tokens !== undefined ? { inputTokens: parsed.usage.input_tokens } : {}),
            ...(parsed?.usage?.cache_read_input_tokens !== undefined
                ? { cachedInputTokens: parsed.usage.cache_read_input_tokens } : {}),
            ...(parsed?.usage?.output_tokens !== undefined ? { outputTokens: parsed.usage.output_tokens } : {}),
        };
        let base = {
            exitCode: result.exitCode, durationMs: result.durationMs, output: parsed?.result ?? "",
            outputArtifact, usage, ...(parsed?.session_id ? { sessionId: parsed.session_id } : {}),
        };
        if (result.timedOut) return { ...base, status: "timeout", error: `no result within ${request.timeoutMs}ms` };
        if (result.exitCode !== 0 || parsed === undefined || parsed.is_error) {
            let reason = parsed?.subtype ?? parsed?.result ?? result.stderr.trim().split("\n").slice(-5).join("\n");
            return { ...base, status: "error", error: reason || `exit code ${result.exitCode}` };
        }
        return { ...base, status: "success" };
    }
}
