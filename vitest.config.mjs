import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    pool: "@cloudflare/vitest-pool-workers",
    include: ["test/integration.runtime.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: true,
        wrangler: {
          configPath: "./test/fixtures/wrangler.test.toml",
        },
      },
    },
  },
});
