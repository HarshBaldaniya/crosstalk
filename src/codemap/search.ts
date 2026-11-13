// Finding code by words: BM25 over each declaration's name, the class it sits in, its doc line and
// its file's path, with boosts for an exact name. No AI, no embeddings.
import type { Decl } from "./extract";
import type { FileEntry } from "./store";

const STOP = new Set(
  `a an the and or but if then else of to in on at by for from with without into onto over under about as is are was were be been being
  it its this that these those there here where what which who whom whose why how when do does did done doing can could should would will
  shall may might must i me my we our you your he she they them their not no yes so too very just also only still even any all some each
  every please pls plz fix fixed fixing add added adding make makes made making update updated updating change changed changing create
  created creating remove removed removing delete deleted use used using want need needs show shows see look find found get got let lets
  work works working thing things way like etc issue issues problem problems bug bugs error errors wrong right new old now same other
  file files code function functions component components`.split(/\s+/),
);

/** Splits text into search words: camelCase, snake_case, kebab-case and paths come apart; plurals fold. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2")
      .split(" ");
    for (const p of parts) {
      const w = fold(p.toLowerCase());
      if (w.length > 1) out.push(w);
    }
  }
  return out;
}

function fold(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export interface Doc {
  file: FileEntry;
  decl?: Decl;
}

interface Posting {
  doc: number;
  tf: number;
}

const W_NAME = 3;
const W_PARENT = 1;
const W_DOC = 1;
const W_PATH = 1.2;
const K1 = 1.2;
const B = 0.6;

const LOW_VALUE_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|fixtures?|mocks?|stories|storybook|examples?|scripts|migrations|testdata)(\/|$)|\.(test|spec|stories|story|e2e|mock)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|conftest\.py$|(Test|Tests|Spec)\.(java|cs|php)$|_spec\.rb$|(^|\/)src\/test\//i;

export function isLowValuePath(p: string): boolean {
  return LOW_VALUE_PATH.test(p);
}

const KIND_WEIGHT: Record<string, number> = {
  component: 1.05,
  hook: 1.05,
  function: 1,
  class: 1,
  route: 1.1,
  interface: 0.95,
  type: 0.9,
  enum: 0.9,
  method: 0.9,
  namespace: 0.8,
  const: 0.75,
};

/** Words in a question that name a kind of declaration. */
const KIND_WORDS: Record<string, string> = {
  hook: "hook",
  component: "component",
  interface: "interface",
  type: "type",
  enum: "enum",
  class: "class",
  route: "route",
  endpoint: "route",
  method: "method",
  constant: "const",
  const: "const",
};

export interface Hit {
  doc: Doc;
  score: number;
}

export class SearchIndex {
  readonly docs: Doc[] = [];
  private postings = new Map<string, Posting[]>();
  private lengths: number[] = [];
  private avg = 1;
  /** Lowercased full names → docs, for exact matches */
  private exact = new Map<string, number[]>();
  /** Lowercased file names without extension → that file's docs */
  private fileNames = new Map<string, number[]>();

  constructor(files: Iterable<FileEntry>) {
    for (const file of files) {
      const pathWords = words(file.p.split("/").slice(-4).join(" "));
      if (!file.d.length) this.add({ file }, [], [], [], pathWords);
      for (const decl of file.d) {
        this.add({ file, decl }, words(decl.n), decl.p ? words(decl.p) : [], decl.d ? words(decl.d) : [], pathWords);
      }
    }
    const total = this.lengths.reduce((a, b) => a + b, 0);
    this.avg = total / Math.max(1, this.lengths.length);
  }

  private add(doc: Doc, name: string[], parent: string[], docWords: string[], pathWords: string[]) {
    const i = this.docs.length;
    this.docs.push(doc);
    const tf = new Map<string, number>();
    const bump = (ws: string[], w: number) => {
      for (const x of ws) tf.set(x, (tf.get(x) ?? 0) + w);
    };
    bump(name, W_NAME);
    bump(parent, W_PARENT);
    bump(docWords, W_DOC);
    bump(pathWords, W_PATH);
    let len = 0;
    for (const [term, f] of tf) {
      len += f;
      let list = this.postings.get(term);
      if (!list) this.postings.set(term, (list = []));
      list.push({ doc: i, tf: f });
    }
    this.lengths.push(len);
    if (doc.decl) {
      const key = doc.decl.n.toLowerCase();
      let list = this.exact.get(key);
      if (!list) this.exact.set(key, (list = []));
      list.push(i);
    }
    const base = (doc.file.p.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
    let byFile = this.fileNames.get(base);
    if (!byFile) this.fileNames.set(base, (byFile = []));
    byFile.push(i);
  }

  private vocab?: string[];

  /**
   * A query word and the indexed words it should also match: itself, a short form's full words
   * ("doc" → document), and, for a word the code never uses, its likely spellings ("editoer" → editor).
   */
  expand(term: string): { term: string; weight: number }[] {
    const out: { term: string; weight: number }[] = [];
    const known = this.postings.has(term);
    if (known) out.push({ term, weight: 1 });
    this.vocab ??= [...this.postings.keys()].sort();
    const v = this.vocab;
    if (term.length >= 3) {
      // Words that start with it: binary search to the first, then walk.
      let lo = 0;
      let hi = v.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v[mid] < term) lo = mid + 1;
        else hi = mid;
      }
      const longer: string[] = [];
      for (let i = lo; i < v.length && v[i].startsWith(term); i++) if (v[i] !== term && v[i].length - term.length <= 7) longer.push(v[i]);
      longer.sort((a, b) => (this.postings.get(b)?.length ?? 0) - (this.postings.get(a)?.length ?? 0));
      for (const w of longer.slice(0, 6)) out.push({ term: w, weight: known ? 0.35 : 0.6 });
    }
    if (!known && term.length >= 4) {
      const maxDist = term.length >= 7 ? 2 : 1;
      const near: { w: string; d: number; df: number }[] = [];
      for (const w of v) {
        if (w[0] !== term[0] || Math.abs(w.length - term.length) > maxDist) continue;
        const d = editDistance(term, w, maxDist);
        if (d <= maxDist) near.push({ w, d, df: this.postings.get(w)?.length ?? 0 });
      }
      near.sort((a, b) => a.d - b.d || b.df - a.df);
      for (const n of near.slice(0, 3)) out.push({ term: n.w, weight: n.d === 1 ? 0.85 : 0.65 });
    }
    return out;
  }

  /** Ranked docs for a question; `boost` multiplies a file's score (graph rank, this chat's files). */
  search(question: string, boost: (doc: Doc) => number = () => 1, limit = 50): Hit[] {
    const raw = question.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    // "the edit rights hook": "hook" names a kind, not a word to look for.
    const kinds = new Set<string>();
    const terms = [
      ...new Set(
        words(question).filter((w) => {
          const k = KIND_WORDS[w];
          if (k && raw.length > 1) {
            kinds.add(k);
            return false;
          }
          return !STOP.has(w);
        }),
      ),
    ];
    // Only something shaped like an identifier (useEditRights, billing_charge, API2) is matched by its
    // exact name; a lone word is, too, when it's all that was asked.
    const exactNames = new Set(
      raw
        .filter((r) => r.length > 2 && (/[a-z][A-Z]|_|\d|^[A-Z]{2,}$/.test(r) || raw.length === 1) && !STOP.has(r.toLowerCase()))
        .map((r) => r.toLowerCase()),
    );
    if (!terms.length && !exactNames.size) return [];

    const N = this.docs.length;
    const scores = new Map<number, number>();
    const matched = new Map<number, number>();
    terms.forEach((term, gi) => {
      const bit = 1 << Math.min(gi, 30);
      for (const { term: t, weight } of this.expand(term)) {
        const list = this.postings.get(t);
        if (!list) continue;
        const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
        for (const { doc, tf } of list) {
          const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * this.lengths[doc]) / this.avg));
          scores.set(doc, (scores.get(doc) ?? 0) + weight * idf * norm);
          matched.set(doc, (matched.get(doc) ?? 0) | bit);
        }
      }
    });
    // A name typed exactly ("useEditRights", "billing_charge") wins outright; a file's name brings
    // up what's in that file.
    const all = (1 << Math.min(terms.length, 30)) - 1;
    for (const name of exactNames) {
      for (const doc of this.exact.get(name) ?? []) {
        scores.set(doc, (scores.get(doc) ?? 0) + 25);
        matched.set(doc, all);
      }
      for (const doc of this.fileNames.get(name) ?? []) {
        scores.set(doc, (scores.get(doc) ?? 0) + 12);
        matched.set(doc, all);
      }
    }
    const termSet = new Set(terms);

    const hits: Hit[] = [];
    for (const [doc, s] of scores) {
      const d = this.docs[doc];
      const coverage = terms.length ? Math.min(1, bits(matched.get(doc) ?? 0) / terms.length) : 1;
      let score = s * (0.35 + 0.65 * coverage * coverage);
      if (d.decl && termSet.size) {
        // Every word of the question in the name itself is the strongest sign of all.
        const nameWords = new Set(words(d.decl.n));
        let inName = 0;
        for (const t of termSet) if (nameWords.has(t)) inName++;
        const share = inName / termSet.size;
        score *= 1 + 3 * share * share;
      }
      if (d.decl) {
        score *= KIND_WEIGHT[d.decl.k] ?? 1;
        if (kinds.size) score *= kinds.has(d.decl.k) ? 1.8 : 0.7;
        if (d.decl.x) score *= 1.1;
      } else score *= 0.6;
      if (isLowValuePath(d.file.p)) score *= 0.4;
      score *= boost(d);
      hits.push({ doc: d, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

function bits(n: number): number {
  let c = 0;
  for (let x = n; x; x &= x - 1) c++;
  return c;
}

/** Damerau-Levenshtein distance, giving up past `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}
