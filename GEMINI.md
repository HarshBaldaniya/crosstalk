# Crosstalk

This extension gives Gemini CLI a map of the project's code and the records of the person's other AI
chats on this computer.

- To find code (where something is defined, what calls it, how a folder is laid out), call
  `crosstalk_map` before searching or reading whole files: `find` for a name or plain words, `outline`
  for a file or folder, `graph` for who uses what, no arguments for an overview.
- When the person refers to earlier work or another chat, call `crosstalk_flightlog`: `query` searches
  every chat, `chat` reads one.
- `crosstalk_notes` holds notes chats left for this project.
