import {
    appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, truncateSync,
    unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import {
    EVENT_VERSION, type EventPayloads, type EventType, type FlowEvent,
} from "../../contracts/events.ts";

export const LEDGER_FILE = "events.jsonl";

/** Brings an event written by an older Flow up to EVENT_VERSION. */
function upcast(event: FlowEvent): FlowEvent {
    if (event.v > EVENT_VERSION) {
        throw new Error(`Ledger event seq ${event.seq} has version ${event.v}; ` +
            `this Flow reads up to ${EVENT_VERSION}. Upgrade Flow.`);
    }
    // No older versions exist yet. Each future bump adds a `if (event.v === N) ...` step here.
    return event;
}

/**
 * Parses events.jsonl. A crash can leave the last line cut off mid-write: that line is skipped,
 * not treated as corruption. Any other unparsable line is corruption and throws.
 */
export function parseLedger(text: string): { events: FlowEvent[]; validBytes: number } {
    let events: FlowEvent[] = [];
    let offset = 0;
    let validBytes = 0;
    let lines = text.split("\n");
    for (let [index, line] of lines.entries()) {
        let isLast = index === lines.length - 1;
        let lineBytes = Buffer.byteLength(line) + (isLast ? 0 : 1);
        if (line.trim() !== "") {
            try {
                events.push(upcast(JSON.parse(line) as FlowEvent));
            } catch (err) {
                if (isLast) break;  // truncated tail from a crash
                throw new Error(`Ledger corrupt at line ${index + 1}: ${(err as Error).message}`);
            }
        }
        offset += lineBytes;
        validBytes = offset;
    }
    return { events, validBytes };
}

export function readLedger(taskDir: string): FlowEvent[] {
    let file = join(taskDir, LEDGER_FILE);
    return existsSync(file) ? parseLedger(readFileSync(file, "utf8")).events : [];
}

export class Ledger {
    readonly taskId: string;
    readonly file: string;
    readonly #now: () => Date;
    #seq: number;

    constructor(taskDir: string, taskId: string, now: () => Date = () => new Date()) {
        mkdirSync(taskDir, { recursive: true });
        this.taskId = taskId;
        this.file = join(taskDir, LEDGER_FILE);
        this.#now = now;
        let events: FlowEvent[] = [];
        if (existsSync(this.file)) {
            let parsed = parseLedger(readFileSync(this.file, "utf8"));
            events = parsed.events;
            // Drop a crash-truncated tail so the next append starts on a clean line.
            truncateSync(this.file, parsed.validBytes);
            // A write cut exactly before its newline leaves a complete event with no terminator.
            if (parsed.validBytes > 0 && !readFileSync(this.file, "utf8").endsWith("\n")) {
                appendFileSync(this.file, "\n");
            }
        }
        this.#seq = events.at(-1)?.seq ?? 0;
    }

    events(): FlowEvent[] {
        return parseLedger(readFileSync(this.file, "utf8")).events;
    }

    append<T extends EventType>(type: T, data: EventPayloads[T], stepId?: string): FlowEvent<T> {
        let event = {
            v: EVENT_VERSION,
            seq: ++this.#seq,
            ts: this.#now().toISOString(),
            taskId: this.taskId,
            ...(stepId === undefined ? {} : { stepId }),
            type,
            data,
        } as FlowEvent<T>;
        appendFileSync(this.file, JSON.stringify(event) + "\n");
        return event;
    }
}

/**
 * Takes the single-writer lock for a task. A lock left by a dead process is reclaimed.
 * Returns a release function.
 */
export function acquireWriter(taskDir: string): () => void {
    mkdirSync(taskDir, { recursive: true });
    let lock = join(taskDir, "writer.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            let fd = openSync(lock, "wx");
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            let pid = Number(readFileSync(lock, "utf8"));
            if (pid && isAlive(pid)) {
                throw new Error(`Task is already being run by process ${pid}.`);
            }
            unlinkSync(lock);
        }
    }
    throw new Error("Could not acquire the task writer lock.");
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
