// The hook's entry point: agents run dist/crosstalk-hook.js after each reply. Only this file runs
// anything when loaded, so tests importing crosstalk-hook.ts never read stdin or exit.
import { main } from "./crosstalk-hook";

main();
