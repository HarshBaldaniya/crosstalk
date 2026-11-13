// Works out each chat's status: from the hook when it is connected (exact),
// otherwise from when the chat's file last changed (a good guess).
import * as fs from "node:fs";
import * as path from "node:path";
import type { HookStatus, Status } from "./types";
import { statusDir } from "./paths";

/** A chat whose file changed this recently is probably still replying. */
const WORKING_MS = 20_000;
/** After this long with no change, a finished chat counts as idle. */
const IDLE_MS = 30 * 60_000;
/** A hook's "working" older than this, with the file quiet, means the reply ended without a Stop event. */
const STALE_WORKING_MS = 10 * 60_000;

export function readHookStatus(sessionId: string): HookStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(statusDir(), `${sessionId}.json`), "utf8")) as HookStatus;
  } catch {
    return undefined;
  }
}

export function resolveStatus(lastModified: number, hook: HookStatus | undefined, now = Date.now()): { status: Status; line?: string } {
  if (hook && lastModified > hook.at + 5_000 && hook.status !== "working") {
    // The chat moved on since the hook last spoke (e.g. it started before the hook was on).
    hook = undefined;
  }
  if (hook) {
    if (hook.status === "working" && now - Math.max(hook.at, lastModified) > STALE_WORKING_MS) {
      return { status: "done" };
    }
    if (hook.status === "done" && now - hook.at > IDLE_MS) return { status: "idle" };
    return { status: hook.status, line: hook.status === "waiting" ? hook.message : undefined };
  }
  const age = now - lastModified;
  if (age < WORKING_MS) return { status: "working" };
  if (age < IDLE_MS) return { status: "done" };
  return { status: "idle" };
}
