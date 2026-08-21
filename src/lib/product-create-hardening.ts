export type ProductPostSaveStage = "asset_cleanup" | "audit" | "cache_revalidation";

type ProductPostSaveTask = {
  stage: ProductPostSaveStage;
  run: () => Promise<void> | void;
  onFailure: (error: unknown) => Promise<void> | void;
};

export async function runProductPostSaveTasks(tasks: ProductPostSaveTask[]) {
  const failedStages: ProductPostSaveStage[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      failedStages.push(task.stage);
      try {
        await task.onFailure(error);
      } catch {
        // A diagnostic failure must not reverse or misreport a committed save.
      }
    }
  }
  return { failedStages };
}

export function createProductSaveSingleFlightGuard() {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    finish() {
      active = false;
    },
  };
}
