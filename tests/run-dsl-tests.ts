export {};

console.log("=== Rich Text DSL ===");
await import("./richText.golden.test.ts");

console.log("=== Position Tracking ===");
await import("./positions.test.ts");

console.log("=== Edge Cases ===");
await import("./edgeCases.test.ts");

console.log("=== Stable Id ===");
await import("./stableId.test.ts");

console.log("=== Dist Smoke ===");
await import("./dist.test.ts");

console.log("=== Context Compat ===");
await import("./contextCompat.test.ts");

console.log("=== Deprecations ===");
await import("./deprecations.test.ts");

console.log("=== Walk / Map ===");
await import("./walk.test.ts");

console.log("=== Type Check ===");
await import("./typecheck.test.ts");

console.log("=== Print / Formatter ===");
await import("./print.test.ts");

console.log("=== Zones ===");
await import("./zones.test.ts");
