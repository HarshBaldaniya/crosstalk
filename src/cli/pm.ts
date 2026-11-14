// npm, pnpm, yarn and bun: which one started Crosstalk, which one owns the `crosstalk` command, and
// how to run each without a shell where one isn't needed. The same on macOS, Windows and Linux.
import * as fs from "node:fs";
import * as path from "node:path";
import { findCommand } from "../core/hooks";
import { npmCommand, NPM_PACKAGE } from "../core/setup";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package manager that started this run (`pnpm create crosstalk`, `bunx crosstalk-ai` ...):
 *  each sets npm_config_user_agent to "<name>/<version> ...". */
export function startedBy(ua = process.env.npm_config_user_agent ?? ""): PackageManager {
  const name = ua.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

const yarnClassic = (ua = process.env.npm_config_user_agent ?? "") => /^yarn\/1\./.test(ua);

/** How to run Crosstalk once, without installing it, with this package manager. */
export function oneOff(pm: PackageManager, ua?: string): string {
  if (pm === "pnpm") return `pnpm dlx ${NPM_PACKAGE}`;
  if (pm === "bun") return `bunx ${NPM_PACKAGE}`;
  if (pm === "yarn" && !yarnClassic(ua)) return `yarn dlx ${NPM_PACKAGE}`;
  return `npx ${NPM_PACKAGE}`;
}

/** How each package manager adds a command for good. Yarn 2+ has no global installs: npm does it. */
export function globalInstall(pm: PackageManager, spec: string, ua?: string): { bin: PackageManager; args: string[] } {
  if (pm === "pnpm") return { bin: "pnpm", args: ["add", "--global", spec] };
  if (pm === "bun") return { bin: "bun", args: ["add", "--global", spec] };
  if (pm === "yarn" && yarnClassic(ua)) return { bin: "yarn", args: ["global", "add", spec] };
  return { bin: "npm", args: ["install", "--global", "--no-fund", "--no-audit", "--loglevel=error", spec] };
}

/** A package manager's command, ready for spawn. npm goes through the npm beside this Node.js; on
 *  Windows the others are .cmd files only a shell can start, so they get one quoted line. */
export function pmCommand(bin: PackageManager | "npx", args: string[]): { cmd: string; args: string[]; shell: boolean } {
  if (bin === "npm" || bin === "npx") return npmCommand(bin, args);
  if (process.platform !== "win32") return { cmd: bin, args, shell: false };
  return { cmd: [bin, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" "), args: [], shell: true };
}

/** A `crosstalk` that only exists for one run: `npm create crosstalk`, npx, pnpm dlx, yarn dlx and
 *  bunx put the package's own node_modules/.bin (with crosstalk-ai's commands in it) at the front of
 *  the PATH while they run. That one is gone afterwards, so it doesn't count as installed. */
export function temporary(file: string): boolean {
  return /[\\/]node_modules[\\/]\.bin[\\/]|[\\/]_npx[\\/]|[\\/]dlx[\\/-]|[\\/]bunx-|[\\/]xfs-/i.test(file);
}

export interface OurCommand {
  /** Where `crosstalk` is on the PATH. */
  path: string;
  /** Which package manager installed it, so `crosstalk update` uses the same one. */
  by: PackageManager;
}

/** Crosstalk's own `crosstalk` command on the PATH, if there is one (another program could use the
 *  name). npm, yarn and bun link it into the package; pnpm, and every manager on Windows, write a
 *  small script that names the package. */
export function ourCommand(found = findCommand("crosstalk")): OurCommand | undefined {
  if (!found || temporary(found)) return undefined;
  let where = "";
  try {
    where = fs.realpathSync(found);
  } catch {
    return undefined;
  }
  let text = where;
  if (!/[\\/]node_modules[\\/]crosstalk-ai[\\/]/.test(where)) {
    try {
      if (fs.statSync(where).size > 64 * 1024) return undefined;
      text = fs.readFileSync(where, "utf8");
    } catch {
      return undefined;
    }
    if (!text.includes(NPM_PACKAGE) && !fs.existsSync(path.join(path.dirname(found), "node_modules", NPM_PACKAGE))) return undefined;
  }
  const by: PackageManager = /pnpm/i.test(text) ? "pnpm" : /[\\/]\.bun[\\/]/.test(text) ? "bun" : /yarn/i.test(text) ? "yarn" : "npm";
  return { path: found, by };
}
