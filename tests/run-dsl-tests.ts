export {};

console.log("=== Rich Text DSL ===");
await import("./richText.golden.test.ts");

console.log("=== Dist Smoke ===");
await import("./dist.test.ts");
