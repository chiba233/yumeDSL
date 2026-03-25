import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const loadTestJsonFixture = async <T>(relativePath: string): Promise<T> => {
  const filePath = path.resolve(__dirname, "fixtures", relativePath);
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text) as T;
};
