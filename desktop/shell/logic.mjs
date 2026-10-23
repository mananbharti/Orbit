// The shell's pure decisions live in src/shell-logic.ts (typechecked and unit-tested there);
// this file only re-exports the compiled module so shell/main.mjs stays plain .mjs.
export { transferRows, knownPath, freshTerminalTransfers, notificationFor } from '../dist/src/shell-logic.js';
