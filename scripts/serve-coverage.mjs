// noinspection HttpUrlsUsage,JSUnresolvedReference

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const coverageRoot = path.join(packageRoot, "coverage");
const coverageSrcRoot = path.join(coverageRoot, "src");

const readCliOption = (optionName) => {
  const optionIndex = process.argv.indexOf(optionName);
  if (optionIndex === -1) {
    return null;
  }
  return process.argv[optionIndex + 1] ?? null;
};

const host = readCliOption("--host") ?? process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(readCliOption("--port") ?? process.env.PORT ?? "3000", 10);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
} ;

const normalizeUrlPath = (urlPath) => {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return urlPath;
  }
};

const toSafeRelativePath = (urlPath) => {
  const normalized = path.posix.normalize(normalizeUrlPath(urlPath));
  const withoutLeadingSlash = normalized.replace(/^\/+/, "");
  if (
    withoutLeadingSlash === "" ||
    withoutLeadingSlash === "." ||
    withoutLeadingSlash.startsWith("../") ||
    withoutLeadingSlash.includes("/../")
  ) {
    return "";
  }
  return withoutLeadingSlash;
};

const fileExists = async (targetPath) => {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const listCoverageTsHtmlFiles = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listCoverageTsHtmlFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts.html")) {
      files.push(entryPath);
    }
  }

  return files;
};

const buildCoverageAliasMap = async () => {
  const tsHtmlFiles = await listCoverageTsHtmlFiles(coverageSrcRoot);
  const aliasMap = new Map();

  for (const filePath of tsHtmlFiles) {
    const basename = path.basename(filePath, ".html");
    const relativePath = path.relative(coverageRoot, filePath);
    const existing = aliasMap.get(basename);
    if (!existing) {
      aliasMap.set(basename, relativePath);
    } else if (existing !== relativePath) {
      aliasMap.set(basename, null);
    }
  }

  return aliasMap;
};

const resolveCoverageFile = async (urlPath, aliasMap) => {
  const safeRelativePath = toSafeRelativePath(urlPath);
  const directCandidates = [];

  if (safeRelativePath === "") {
    directCandidates.push("index.html");
  } else {
    directCandidates.push(safeRelativePath);
    if (!path.extname(safeRelativePath)) {
      directCandidates.push(path.join(safeRelativePath, "index.html"));
    }
    if (safeRelativePath.endsWith(".ts")) {
      directCandidates.push(`${safeRelativePath}.html`);
    }
  }

  for (const relativeCandidate of directCandidates) {
    const absoluteCandidate = path.join(coverageRoot, relativeCandidate);
    if (await fileExists(absoluteCandidate)) {
      return absoluteCandidate;
    }
  }

  if (safeRelativePath.startsWith("src/") && safeRelativePath.endsWith(".ts")) {
    const basename = path.basename(safeRelativePath);
    const aliasedRelativePath = aliasMap.get(basename);
    if (aliasedRelativePath) {
      const aliasedAbsolutePath = path.join(coverageRoot, aliasedRelativePath);
      if (await fileExists(aliasedAbsolutePath)) {
        return aliasedAbsolutePath;
      }
    }
  }

  return null;
};

const sendResponse = async (response, statusCode, body, contentType) => {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
};

const aliasMap = await buildCoverageAliasMap();

const getAccessibleUrls = (boundHost, boundPort) => {
  if (boundHost !== "0.0.0.0" && boundHost !== "::") {
    return [`http://${boundHost}:${boundPort}`];
  }

  const urls = new Set([`http://localhost:${boundPort}`]);
  const networkInterfaces = os.networkInterfaces();

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) {
      continue;
    }
    for (const address of interfaceAddresses) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }
      urls.add(`http://${address.address}:${boundPort}`);
    }
  }

  return [...urls];
};

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const resolvedFile = await resolveCoverageFile(requestUrl.pathname, aliasMap);

  if (!resolvedFile) {
    await sendResponse(response, 404, "Not Found", "text/plain; charset=utf-8");
    return;
  }

  try {
    const content = await fs.readFile(resolvedFile);
    const contentType = MIME_TYPES[path.extname(resolvedFile)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  } catch {
    await sendResponse(response, 500, "Internal Server Error", "text/plain; charset=utf-8");
  }
});

server.listen(port, host, () => {
  const accessibleUrls = getAccessibleUrls(host, port);
  console.log("Serving coverage report at:");
  for (const url of accessibleUrls) {
    console.log(`  ${url}`);
  }
});
