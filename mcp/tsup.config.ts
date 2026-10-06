import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: "node18",
  // @watchupltd/core is internal: bundle it.
  noExternal: ["@watchupltd/core"],
});
