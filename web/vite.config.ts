import { defineConfig } from "vite";

// The build goes straight into the Worker's assets directory, so `wrangler deploy` ships it.
export default defineConfig({
  build: {
    outDir: "../infra/worker/public",
    emptyOutDir: true,
  },
});
