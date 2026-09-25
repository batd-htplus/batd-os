export type ProcessResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
};

export type ProcessOptions = {
    cwd: string;
    input?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    shell?: boolean;
};

export interface ProcessRunner {
    run(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult>;
}

export interface Git {
    isRepo(dir: string): boolean;
    topLevel(dir: string): string;
    head(dir: string): string;
    addWorktree(repo: string, path: string, branch: string, base: string): void;
    changedFiles(worktree: string): string[];
    commitAll(worktree: string, message: string): string | null;
    lsFiles(dir: string): string[];
}
