// Starts the built MCP server the way an AI tool would and calls its tools over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const built = path.join(__dirname, "..", "dist", "crosstalk-mcp.js");

test("the MCP server lists, saves and reads notes", { skip: !fs.existsSync(built) && "run npm run build first" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-mcp-"));
  const child = spawn(process.execPath, [built], { env: { ...process.env, CROSSTALK_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: any) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const n = ++id;
      pending.set(n, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
    });

  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const tools = await call("tools/list", {});
    assert.deepEqual(tools.result.tools.map((t: { name: string }) => t.name).sort(), ["crosstalk_flightlog", "crosstalk_map", "crosstalk_notes"]);

    const definitions = Math.ceil(JSON.stringify(tools.result.tools).length / 4);
    assert.ok(definitions < 400, `every chat pays ${definitions} tokens for Crosstalk's tool definitions`);

    const empty = await call("tools/call", { name: "crosstalk_notes", arguments: {} });
    assert.match(empty.result.content[0].text, /No notes yet/);

    const saved = await call("tools/call", { name: "crosstalk_notes", arguments: { title: "Billing fix", text: "Prices come from the server." } });
    const name = /Saved as (\S+)\./.exec(saved.result.content[0].text)![1];

    const read = await call("tools/call", { name: "crosstalk_notes", arguments: { name } });
    assert.equal(read.result.content[0].text, "# Billing fix\n\nPrices come from the server.\n");

    const escape = await call("tools/call", { name: "crosstalk_notes", arguments: { name: "../../etc/passwd" } });
    assert.equal(escape.result.isError, true);
  } finally {
    child.kill();
  }
});
