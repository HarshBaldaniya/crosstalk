# Security

Crosstalk runs on your computer. It reads the session files Claude Code, Codex and Gemini CLI keep
in your home folder, writes its own data to `~/.crosstalk`, and, when you turn them on, adds a hook
and a tool server to those agents' settings (backing each file up first). It does not send your
chats anywhere, run a model of its own, or read login or token files.

## Reporting a problem

Please report a vulnerability privately through GitHub: on this repository, open **Security** →
**Report a vulnerability**. Don't open a public issue for it.

Say what you found, how to reproduce it, and what it lets someone do. You'll get a reply within a
week.
