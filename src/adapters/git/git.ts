import { spawnSync } from "node:child_process";
import type { Git } from "../../contracts/infra.ts";

// Inherited git env vars (e.g. when run from a git hook) would redirect -C/cwd to another repo.
// From ecc/scripts/lib/worktree-lifecycle/git.js.
const INHERITED_GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

function hermeticEnv(): NodeJS.ProcessEnv {
    let env = { ...process.env };
    for (let key of INHERITED_GIT_ENV) delete env[key];
    return env;
}

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
    let result = spawnSync("git", args, {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env: hermeticEnv(),
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function must(cwd: string, args: string[]): string {
    let result = run(cwd, args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
}

const splitNul = (text: string): string[] => text.split("\0").filter(entry => entry !== "");

export class CliGit implements Git {
    isRepo(dir: string): boolean {
        return run(dir, ["rev-parse", "--is-inside-work-tree"]).status === 0;
    }

    topLevel(dir: string): string {
        return must(dir, ["rev-parse", "--show-toplevel"]).trim();
    }

    head(dir: string): string {
        return must(dir, ["rev-parse", "HEAD"]).trim();
    }

    addWorktree(repo: string, path: string, branch: string, base: string): void {
        must(repo, ["worktree", "add", "-b", branch, path, base]);
    }

    changedFiles(worktree: string): string[] {
        // Porcelain v1 -z: "XY path\0", renames add "orig\0" after the new path.
        let entries = splitNul(must(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
        let files: string[] = [];
        for (let i = 0; i < entries.length; i++) {
            let status = entries[i].slice(0, 2);
            files.push(entries[i].slice(3));
            if (status.startsWith("R") || status.startsWith("C")) i++;
        }
        return files;
    }

    commitAll(worktree: string, message: string): string | null {
        must(worktree, ["add", "-A"]);
        if (run(worktree, ["diff", "--cached", "--quiet"]).status === 0) return null;
        let identity = run(worktree, ["config", "user.email"]).stdout.trim() === ""
            ? ["-c", "user.name=Flow", "-c", "user.email=flow@localhost"] : [];
        must(worktree, [...identity, "commit", "-q", "-m", message]);
        return this.head(worktree);
    }

    lsFiles(dir: string): string[] {
        return splitNul(must(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
    }
}
