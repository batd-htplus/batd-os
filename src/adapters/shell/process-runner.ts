import { spawn } from "node:child_process";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../../contracts/infra.ts";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

/** Keeps at most MAX_CAPTURE_BYTES, dropping the oldest output (the tail is what explains failures). */
class Capture {
    #chunks: Buffer[] = [];
    #bytes = 0;
    add(chunk: Buffer): void {
        this.#chunks.push(chunk);
        this.#bytes += chunk.length;
        while (this.#bytes > MAX_CAPTURE_BYTES && this.#chunks.length > 1) {
            this.#bytes -= this.#chunks.shift()!.length;
        }
    }
    text(): string {
        return Buffer.concat(this.#chunks).toString("utf8");
    }
}

/** Runs commands in their own process group so a timeout kills the whole tree. */
export class NodeProcessRunner implements ProcessRunner {
    run(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
        let started = Date.now();
        return new Promise(resolve => {
            let child = spawn(command, args, {
                cwd: options.cwd,
                env: { ...process.env, ...options.env },
                shell: options.shell ?? false,
                detached: process.platform !== "win32",
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = new Capture();
            let stderr = new Capture();
            let timedOut = false;
            let killGroup = (signal: NodeJS.Signals) => {
                try {
                    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal);
                    else child.kill(signal);
                } catch { /* already exited */ }
            };
            let timer = setTimeout(() => {
                timedOut = true;
                killGroup("SIGTERM");
                setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
            }, options.timeoutMs);
            child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
            child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
            child.stdin.on("error", () => { /* child closed stdin early */ });
            child.stdin.end(options.input ?? "");
            let finish = (exitCode: number, extraErr = "") => {
                clearTimeout(timer);
                resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text() + extraErr,
                    durationMs: Date.now() - started, timedOut });
            };
            child.on("error", err => finish(127, `${err.message}\n`));
            child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
        });
    }
}
