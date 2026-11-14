import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/*.test.ts"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "chaos",
          include: ["test/chaos/*.test.ts"],
          // Each test spawns and kills real executor processes; C5 alone runs 50 rounds.
          testTimeout: 600_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
