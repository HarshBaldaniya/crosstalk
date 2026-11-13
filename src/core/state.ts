// The workspace's board, in `.crosstalk/state.json`: which chats are on it and where.
import * as path from "node:path";
import type { BoardState } from "./types";
import { readJson, workspaceCrosstalkDir, workspaceCrosstalkPath, writeFileAtomic } from "./paths";

export class BoardStore {
  constructor(private readonly root: string) {}

  private file(): string {
    return path.join(workspaceCrosstalkPath(this.root), "state.json");
  }

  read(): BoardState {
    const s = readJson<{ board?: Partial<BoardState> }>(this.file(), {});
    return { members: s.board?.members ?? [], positions: s.board?.positions ?? {}, handles: s.board?.handles ?? {}, arrange: s.board?.arrange, seeded: s.board?.seeded, viewport: s.board?.viewport };
  }

  update(change: (b: BoardState) => void): BoardState {
    const b = this.read();
    change(b);
    b.members = [...new Set(b.members)];
    workspaceCrosstalkDir(this.root);
    writeFileAtomic(this.file(), JSON.stringify({ board: b }, null, 2));
    return b;
  }

  add(ids: string[]): BoardState {
    return this.update((b) => {
      for (const id of ids) if (!b.members.includes(id)) b.members.push(id);
    });
  }
}
