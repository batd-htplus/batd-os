import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PolicyDecision, PolicyRequest } from "../../contracts/tool.ts";

export type Grants = {
    /** The task worktree: the only place writes may land. */
    worktree: string;
    /** Command prefixes the step may run. */
    exec: string[];
    network: boolean;
    /** Subjects a human already approved (`policy:<...>`). */
    approved: string[];
};

// From ECC config-protection.js: linter/formatter configs an agent must not weaken to get green.
// Plus Flow's own configuration and CI definitions.
const PROTECTED_FILES = new Set([
    ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts",
    "eslint.config.mts", "eslint.config.cts",
    ".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", ".prettierrc.yml",
    ".prettierrc.yaml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs",
    "biome.json", "biome.jsonc", ".ruff.toml", "ruff.toml", ".shellcheckrc", ".stylelintrc",
    ".stylelintrc.json", ".stylelintrc.yml", ".markdownlint.json", ".markdownlint.yaml",
    ".markdownlintrc",
]);
const PROTECTED_DIRS = [".flow/", ".github/workflows/", ".gitlab-ci"];

// From ECC block-no-verify.js (condensed): git hook bypasses are never allowed.
const HOOK_BYPASS = /\bgit\b[^;&|]*(\s--no-verify\b|\s-c\s+core\.hookspath=)/i;

/** Canonicalizes a path that may not exist yet (ECC path-safety: defeats symlinked parents). */
function realpathNearestExisting(target: string): string {
    let current = resolve(target);
    let tail: string[] = [];
    while (!exists(current)) {
        let parent = dirname(current);
        if (parent === current) break;
        tail.unshift(basename(current));
        current = parent;
    }
    let real = realpathSync(current);
    return tail.length > 0 ? join(real, ...tail) : real;
}

function exists(path: string): boolean {
    try { lstatSync(path); return true; } catch { return false; }
}

export function isWithin(target: string, root: string): boolean {
    if (!existsSync(root)) return false;
    let rel = relative(realpathNearestExisting(root), realpathNearestExisting(target));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function isProtected(relPath: string): boolean {
    let normalized = relPath.split(sep).join("/");
    return PROTECTED_FILES.has(basename(normalized).toLowerCase()) ||
        PROTECTED_DIRS.some(dir => normalized.startsWith(dir));
}

function commandAllowed(command: string, allowed: string[]): boolean {
    let trimmed = command.trim();
    return allowed.some(prefix => trimmed === prefix || trimmed.startsWith(prefix + " "));
}

export function decide(request: PolicyRequest, grants: Grants): PolicyDecision {
    let ask = (subject: string, reason: string): PolicyDecision =>
        grants.approved.includes(`policy:${subject}`) ? { decision: "allow" }
            : { decision: "ask", subject: `policy:${subject}`, reason };
    switch (request.effect) {
        case "read":
            return { decision: "allow" };
        case "write": {
            let path = resolve(grants.worktree, request.path);
            if (!isWithin(path, grants.worktree)) {
                return { decision: "deny", reason: `write outside the task worktree: ${request.path}` };
            }
            let rel = relative(grants.worktree, path);
            return isProtected(rel)
                ? ask(`write:${rel}`, `changes protected configuration file ${rel}`)
                : { decision: "allow" };
        }
        case "exec":
            if (HOOK_BYPASS.test(request.command)) {
                return { decision: "deny", reason: "git hook bypass (--no-verify / core.hooksPath)" };
            }
            return commandAllowed(request.command, grants.exec) ? { decision: "allow" }
                : ask(`exec:${request.command}`, `runs undeclared command: ${request.command}`);
        case "net":
            return grants.network ? { decision: "allow" }
                : { decision: "deny", reason: `network access is not granted (${request.target})` };
        case "git":
            return ask(`git:${request.op}`, `git ${request.op} needs approval`);
    }
}

/** Audits the files an engine changed: the first non-allow decision stops the step. */
export function auditChanges(changedFiles: string[], grants: Grants): PolicyDecision {
    for (let file of changedFiles) {
        let decision = decide({ effect: "write", path: file }, grants);
        if (decision.decision !== "allow") return decision;
    }
    return { decision: "allow" };
}
