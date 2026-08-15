import {
  blockPhase4B5ProviderPreflight,
  blockPhase4B5RealExecution,
  createPhase4B5ManualPlan,
} from "../src/lib/backups/v2/manual-workflow.ts";

function safeFailure(error) {
  return {
    status: "blocked",
    code: typeof error === "object" && error !== null && typeof error.code === "string"
      ? error.code
      : "BACKUP_V2_MANUAL_WORKFLOW_FAILED",
  };
}

const argumentsList = process.argv.slice(2);
const selected = argumentsList.length === 0 || argumentsList.includes("--plan")
  ? "plan"
  : argumentsList.includes("--synthetic-execute")
    ? "synthetic"
    : argumentsList.includes("--provider-preflight")
      ? "preflight"
      : argumentsList.includes("--execute-production")
        ? "production"
        : "help";

try {
  if (selected === "plan") {
    process.stdout.write(`${JSON.stringify(createPhase4B5ManualPlan(), null, 2)}\n`);
  } else if (selected === "synthetic") {
    const { runPhase4B5SyntheticWorkflow } = await import("./test-backup-v2-phase4b5-b2.mjs");
    const result = await runPhase4B5SyntheticWorkflow({ manual: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (selected === "preflight") {
    blockPhase4B5ProviderPreflight();
  } else if (selected === "production") {
    blockPhase4B5RealExecution();
  } else {
    process.stdout.write("Usage: npm run backup:v2:manual -- [--plan|--synthetic-execute|--provider-preflight|--execute-production]\n");
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
  process.exitCode = 2;
}
