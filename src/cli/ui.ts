// How the command line looks: colour only in a terminal that wants it (NO_COLOR, --no-color, pipes,
// CI logs and dumb terminals stay plain).
let colour = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export function plain(): void {
  colour = false;
}

const tint = (code: string) => (t: string) => (colour ? `\x1b[${code}m${t}\x1b[0m` : t);
export const paint = { ok: tint("32"), warn: tint("33"), bad: tint("31"), dim: tint("2"), bold: tint("1"), accent: tint("36") };

export const out = (t = "") => process.stdout.write(`${t}\n`);

/** Two columns, the first padded to the widest. */
export function columns(rows: [string, string][], indent = 2, gap = 3, width?: number): string {
  const w = width ?? Math.max(0, ...rows.map(([a]) => a.length)) + gap;
  return rows.map(([a, b]) => `${" ".repeat(indent)}${a.padEnd(w)}${b}`).join("\n");
}
