/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The committed deployments/ folder (deploy output) lives outside frontend/ and is imported
// as data. ABIs are now frontend-owned (src/lib/abis.ts), so no @abis alias.
const deployments = fileURLToPath(new URL("../deployments", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Read VITE_* from the repo-root .env so a single .env governs the whole stack.
  envDir: repoRoot,
  resolve: {
    alias: {
      "@deployments": deployments,
    },
  },
  server: {
    port: 5173,
    // Allow importing the committed deployments/ files that live outside frontend/.
    fs: { allow: [repoRoot] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
