import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.open-source-excluded/**", "**/src-tauri/target/**"],
  },
});
