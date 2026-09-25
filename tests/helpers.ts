import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingEngine, EngineRequest, EngineResult } from "../src/contracts/engine.ts";

export function tempDir(prefix = "flow-test-"): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

/** A git repo with one commit. */
export function tempRepo(): string {
    let repo = tempDir("flow-repo-");
    let git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t", ...args],
        { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# demo\n\nsignup form handles email validation\n");
    writeFileSync(join(repo, "signup.js"), "export function signup(email) {\n  return email;\n}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    return repo;
}

export type Script = (request: EngineRequest) => Partial<EngineResult> | void;

/** A coding engine whose behaviour per call is scripted by the test. */
export class FakeEngine implements CodingEngine {
    readonly id = "fake";
    readonly requests: EngineRequest[] = [];
    readonly #script: Script;

    constructor(script: Script) {
        this.#script = script;
    }

    async run(request: EngineRequest): Promise<EngineResult> {
        this.requests.push(request);
        let partial = this.#script(request) ?? {};
        return { status: "success", exitCode: 0, durationMs: 1, output: "", outputArtifact: "artifacts/engine/fake.json",
            usage: { costUsd: 0.1 }, ...partial };
    }
}
