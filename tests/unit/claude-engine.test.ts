import { strict as assert } from "node:assert";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { EngineRequest } from "../../src/contracts/engine.ts";
import { NodeProcessRunner } from "../../src/adapters/shell/process-runner.ts";
import { claudeArgs, ClaudeCodeEngine } from "../../src/engines/claude-code/engine.ts";
import { tempDir } from "../helpers.ts";

const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
    taskId: "t", stepId: "implement", attempt: 2, workingDirectory: tempDir(), prompt: "do it", timeoutMs: 10_000,
    policy: { edit: true, exec: ["npm test"], network: false }, artifactDir: join(tempDir(), "engine"), ...extra,
});

test("maps Flow policy to Claude Code permission flags", () => {
    let args = claudeArgs(request({ maxBudgetUsd: 1.5, model: "sonnet" }));
    assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "json", "--permission-mode", "dontAsk"]);
    assert.ok(args.includes("Edit") && args.includes("Bash(npm test:*)"));
    let disallowed = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--max-budget-usd"));
    assert.deepEqual(disallowed, ["WebFetch", "WebSearch"]);
    assert.deepEqual(args.slice(-4), ["--max-budget-usd", "1.50", "--model", "sonnet"]);
    let readOnly = claudeArgs(request({ policy: { edit: false, exec: [], network: false } }));
    assert.ok(!readOnly.includes("Bash(npm test:*)"));
    assert.ok(readOnly.slice(readOnly.indexOf("--disallowedTools")).includes("Edit"));
    assert.throws(() => claudeArgs(request({ model: "x; rm -rf /" })), /invalid model/);
});

function fakeClaude(script: string): string {
    let bin = join(tempDir(), "claude");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
}

test("runs the CLI with the prompt on stdin and parses its JSON result", async () => {
    let bin = fakeClaude(`read prompt; printf '{"type":"result","subtype":"success","is_error":false,"result":"got: %s",` +
        `"session_id":"s1","total_cost_usd":0.25,"usage":{"input_tokens":10,"cache_read_input_tokens":7,"output_tokens":3}}' "$prompt"`);
    let req = request();
    let result = await new ClaudeCodeEngine(new NodeProcessRunner(), bin).run(req);
    assert.equal(result.status, "success");
    assert.equal(result.output, "got: do it");
    assert.deepEqual(result.usage, { costUsd: 0.25, inputTokens: 10, cachedInputTokens: 7, outputTokens: 3 });
    assert.equal(result.outputArtifact, "artifacts/engine/implement-2.claude.json");
    assert.match(readFileSync(join(req.artifactDir, "implement-2.claude.json"), "utf8"), /session_id/);
});

test("reports CLI errors and non-JSON output as engine errors", async () => {
    let limited = fakeClaude(`printf '{"type":"result","subtype":"error_max_budget","is_error":true}'`);
    let result = await new ClaudeCodeEngine(new NodeProcessRunner(), limited).run(request());
    assert.equal(result.status, "error");
    assert.equal(result.error, "error_max_budget");
    let crashing = fakeClaude("echo not logged in >&2; exit 1");
    assert.match((await new ClaudeCodeEngine(new NodeProcessRunner(), crashing).run(request())).error!, /not logged in/);
});
