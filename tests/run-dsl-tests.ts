export {};

console.log("=== Rich Text DSL ===");
await import("./richText.golden.test.ts");

console.log("=== Position Tracking ===");
await import("./positions.test.ts");

console.log("=== Dist Smoke ===");
await import("./dist.test.ts");

console.log("=== Type Check ===");
await import("./typecheck.test.ts");
