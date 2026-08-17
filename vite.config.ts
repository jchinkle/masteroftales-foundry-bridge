import { defineConfig } from "vitest/config";

// The module ships a single ESM bundle at `dist/main.js`, which is exactly the
// path `module.json`'s `esmodules` points at. The release zip therefore carries
// `module.json` + `dist/` + the docs, and Foundry needs nothing else.
//
// Deliberately unminified: this repo is public precisely so a customer can read
// what the module does with the credential they paste into it, and a minified
// bundle would make that a lie of omission. The bundle is a few KB either way.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      output: {
        // One file. Foundry loads `esmodules` entries directly, so a bundle that
        // split into chunks would need every chunk listed in module.json.
        codeSplitting: false,
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
