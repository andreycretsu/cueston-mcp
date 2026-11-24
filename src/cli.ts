/** Entry point of the `cueston` binary. */
import { buildProgram, reportError } from "./program.js";

async function main(argv: string[]) {
  const program = buildProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  const jsonMode = argv.includes("--json");
  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.exitCode = reportError(error, jsonMode);
  }
}

// Ctrl+C while waiting (login, prompts): exit quietly with the conventional code.
process.on("SIGINT", () => {
  process.stderr.write("\n");
  process.exit(130);
});

void main(process.argv);
