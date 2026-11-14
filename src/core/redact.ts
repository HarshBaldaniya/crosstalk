// Secrets people paste into a chat (an API key to try something, a token in a log) are never
// copied into a flightlog, sent to another chat or returned by a tool. Each pattern is anchored on a
// fixed prefix and bounded, so it is fast on long chat text and can't backtrack badly.
const SECRET =
  /\b(?:sk-ant-[\w-]{20,200}|sk-(?:proj-|svcacct-)?[\w-]{20,200}|AIza[\w-]{35}|gh[pousr]_\w{36,255}|github_pat_\w{22,255}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,200}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|npm_\w{36}|hf_\w{30,}|sk_(?:live|test)_\w{20,}|rk_(?:live|test)_\w{20,}|eyJ[\w-]{10,2000}\.[\w-]{10,2000}\.[\w-]{10,2000})|(?<=\bBearer\s{1,4})[\w.~+/=-]{20,2000}|-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

export const REDACTED = "[secret removed]";

export function redact(text: string): string {
  return text.replace(SECRET, REDACTED);
}
