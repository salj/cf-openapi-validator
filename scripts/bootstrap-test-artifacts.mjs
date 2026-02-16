import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const metaFile = path.join(artifactsDir, "meta.mjs");
const versionLoadersFile = path.join(artifactsDir, "versionLoaders.mjs");

const metaSource = `export default {
  source: "test",
  latestTag: null,
  availableVersions: [],
  generatedAt: null,
};
`;

const versionLoadersSource = `export const availableVersions = [];
export const latestVersion = null;
export function hasVersion() {
  return false;
}
export async function loadVersionModule() {
  return null;
}
export default {
  availableVersions,
  latestVersion,
  hasVersion,
  loadVersionModule,
};
`;

await mkdir(artifactsDir, { recursive: true });
await writeFile(metaFile, metaSource, "utf8");
await writeFile(versionLoadersFile, versionLoadersSource, "utf8");
