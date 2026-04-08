import { defineConfig } from "tsup";

const coverageSourcemapEnabled = process.env.YUME_DSL_COVERAGE_SOURCEMAP === "1";

export default defineConfig({
  entry: ["src/*.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  bundle: false,
  sourcemap: coverageSourcemapEnabled,
  splitting: false,
});
