// The crosstalk command's entry point. The only file that runs anything when loaded: main.ts and
// everything else only export, so a test (or any other code) importing them never sets anything up.
import { main, updateNote } from "./main";

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) {
      updateNote(process.argv[2]);
      process.exit(code);
    }
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
