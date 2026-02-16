#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { Octokit } from "@octokit/rest";

interface SourceConfig {
  sourceRepo?: string;
  schemaPath?: string;
  artifactsUserAgent?: string;
}

interface ParsedArgs {
  tag: string | null;
  syncTags: boolean;
  limit: number | null;
  force: boolean;
  requireRelease: boolean;
  configFile: string;
}

interface GitHubReleaseEntry {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface OpenApiSchema {
  openapi: string;
  paths: Record<string, unknown>;
  info?: {
    version?: string;
  };
  [key: string]: unknown;
}

interface ResponseSchemaEntry {
  key: string;
  ref: string;
}

interface TagManifest {
  source: string;
  tag: string;
  schemaUrl: string;
  schemaHash: string;
  openapi: string;
  infoVersion: string | null;
  validatorCount: number;
  uniqueObjectCount: number;
  generatedAt: string;
  keyToHash: Record<string, string>;
}

interface ManifestTagEntry {
  schemaHash: string;
  validatorCount: number;
  uniqueObjectCount: number;
  generatedAt: string;
}

interface BuildManifest {
  source: string;
  schemaPath?: string;
  latestTag: string | null;
  updatedAt: string | null;
  releasesEtag?: string | null;
  releaseTags?: string[];
  missingSchemaCutoffTag?: string | null;
  tags: Record<string, ManifestTagEntry>;
}

interface ReleaseTagQueryResult {
  tags: string[];
  etag: string | null;
  notModified: boolean;
}

class HttpError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

type CompileResult =
  | {
      tag: string;
      changed: false;
      skipped: true;
    }
  | {
      tag: string;
      changed: boolean;
      skipped: false;
      meta: TagManifest;
      newObjects: number;
    };

let SOURCE_REPO = "";
let SCHEMA_PATH = "";
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const ROOT_SCHEMA_ID = "https://openapi.local/schema.json";
const COMPILED_SCHEMA_ID_PREFIX = "https://openapi.local/compiled";
let USER_AGENT =
  process.env.OPENAPI_ARTIFACTS_USER_AGENT ||
  "openapi-validator-artifact-builder";

const ARTIFACTS_DIR = path.resolve("artifacts");
const OBJECTS_DIR = path.join(ARTIFACTS_DIR, "objects");
const TAGS_DIR = path.join(ARTIFACTS_DIR, "tags");
const MANIFEST_PATH = path.join(ARTIFACTS_DIR, "manifest.json");

const GENERATED_VERSIONS_DIR = path.join(ARTIFACTS_DIR, "versions");
const GENERATED_VERSION_LOADERS_PATH = path.join(
  ARTIFACTS_DIR,
  "versionLoaders.mjs",
);
const GENERATED_META_PATH = path.join(ARTIFACTS_DIR, "meta.mjs");

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenApiSchema(value: unknown): value is OpenApiSchema {
  if (!isObjectRecord(value)) return false;
  if (typeof value.openapi !== "string") return false;
  if (!isObjectRecord(value.paths)) return false;
  return true;
}

function isTagManifest(value: unknown): value is TagManifest {
  if (!isObjectRecord(value)) return false;
  if (typeof value.tag !== "string") return false;
  if (!isObjectRecord(value.keyToHash)) return false;
  return true;
}

function parseRepo(value: string): { owner: string; repo: string } | null {
  if (!value) return null;
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function getOctokit(): Octokit {
  return new Octokit({
    userAgent: USER_AGENT,
    auth: process.env.GITHUB_TOKEN || undefined,
  });
}

function getRequiredGithubRepo(): { owner: string; repo: string } {
  const parsed = parseRepo(SOURCE_REPO);
  if (!parsed) {
    throw new Error(
      "sourceRepo must be set as owner/repo for release operations.",
    );
  }
  return parsed;
}

function assertConfig(): void {
  if (!parseRepo(SOURCE_REPO)) {
    throw new Error(
      "Missing sourceRepo (owner/repo) for GitHub release lookup.",
    );
  }
  if (!SCHEMA_PATH || !SCHEMA_PATH.trim()) {
    throw new Error("Missing schemaPath in source config.");
  }
}

async function loadSourceConfig(configFile: string): Promise<void> {
  if (!configFile) return;
  const config = await readJson<SourceConfig | null>(configFile, null);
  if (!config || typeof config !== "object") return;

  if (typeof config.sourceRepo === "string") SOURCE_REPO = config.sourceRepo;
  if (typeof config.schemaPath === "string") SCHEMA_PATH = config.schemaPath;
  if (
    typeof config.artifactsUserAgent === "string" &&
    config.artifactsUserAgent
  )
    USER_AGENT = config.artifactsUserAgent;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    tag: null,
    syncTags: false,
    limit: null,
    force: false,
    requireRelease: false,
    configFile: ".openapi/source.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      parsed.tag = argv[i + 1] || null;
      i += 1;
    } else if (arg === "--sync-tags") {
      parsed.syncTags = true;
    } else if (arg === "--limit") {
      parsed.limit = Number(argv[i + 1] || 0) || null;
      i += 1;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--require-release") {
      parsed.requireRelease = true;
    } else if (arg === "--config-file") {
      parsed.configFile = argv[i + 1] || parsed.configFile;
      i += 1;
    }
  }

  return parsed;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new HttpError(response.status, url);
  }
  return response.text();
}

function isMissingSchemaForTagError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 404;
}

function pointerEscape(value: unknown): string {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeIfChanged(
  filePath: string,
  content: string,
): Promise<boolean> {
  let current: string | null = null;
  try {
    current = await readFile(filePath, "utf8");
  } catch {
    current = null;
  }

  if (current === content) {
    return false;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return true;
}

function semverTuple(tag: string): [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTags(a: string, b: string): number {
  const av = semverTuple(a);
  const bv = semverTuple(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

function sortTagsDesc(tags: string[]): string[] {
  return [...tags].sort((a, b) => compareTags(b, a));
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function tagToModuleName(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function listReleaseTags(
  etag: string | null,
): Promise<ReleaseTagQueryResult> {
  const githubRepo = getRequiredGithubRepo();
  const octokit = getOctokit();
  const tags: string[] = [];
  let page = 1;
  let nextEtag: string | null = null;

  while (true) {
    let response;
    try {
      response = await octokit.request("GET /repos/{owner}/{repo}/releases", {
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        per_page: 100,
        page,
        headers: page === 1 && etag ? { "if-none-match": etag } : undefined,
      });
    } catch (error: unknown) {
      if (isObjectRecord(error) && "status" in error && error.status === 304) {
        return {
          tags: [],
          etag: etag || null,
          notModified: true,
        };
      }
      throw error;
    }

    if (page === 1) {
      const maybeEtag = response.headers.etag;
      nextEtag = typeof maybeEtag === "string" ? maybeEtag : null;
    }

    const chunk = response.data as GitHubReleaseEntry[];
    if (!Array.isArray(chunk) || chunk.length === 0) break;

    for (const entry of chunk) {
      const tag = entry.tag_name;
      const isPublishedRelease =
        entry.draft === false && entry.prerelease === false;
      if (tag && TAG_RE.test(tag) && isPublishedRelease) {
        tags.push(tag);
      }
    }

    if (chunk.length < 100) break;
    page += 1;
  }

  const sorted = sortTagsDesc(tags);
  return {
    tags: sorted,
    etag: nextEtag,
    notModified: false,
  };
}

async function isPublishedReleaseTag(tag: string): Promise<boolean> {
  const githubRepo = getRequiredGithubRepo();
  const octokit = getOctokit();
  try {
    const { data } = await octokit.repos.getReleaseByTag({
      owner: githubRepo.owner,
      repo: githubRepo.repo,
      tag,
    });
    return data.draft === false && data.prerelease === false;
  } catch (error: unknown) {
    if (isObjectRecord(error) && "status" in error && error.status === 404)
      return false;
    throw error;
  }
}

function normalizeOpenApiNullable(node: unknown): unknown {
  if (Array.isArray(node))
    return node.map((item) => normalizeOpenApiNullable(item));
  if (!isObjectRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = normalizeOpenApiNullable(value);
  }

  if (out.nullable === true) {
    if (typeof out.type === "string") {
      out.type = [out.type, "null"];
    } else if (Array.isArray(out.type)) {
      if (!out.type.includes("null")) out.type = [...out.type, "null"];
    } else if (typeof out.$ref === "string") {
      const currentRef = out.$ref;
      delete out.$ref;
      out.anyOf = [{ $ref: currentRef }, { type: "null" }];
    } else if (Array.isArray(out.anyOf)) {
      out.anyOf = [...out.anyOf, { type: "null" }];
    } else if (Array.isArray(out.oneOf)) {
      out.anyOf = [...out.oneOf, { type: "null" }];
      delete out.oneOf;
    }
  }

  delete out.nullable;
  return out;
}

function collectResponseSchemaEntries(
  schema: OpenApiSchema,
  rootId: string,
): ResponseSchemaEntry[] {
  const entries: ResponseSchemaEntry[] = [];

  for (const [pathName, pathItem] of Object.entries(schema.paths || {})) {
    if (!isObjectRecord(pathItem)) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isObjectRecord(operation)) continue;
      const responses = operation.responses;
      if (!isObjectRecord(responses)) continue;

      for (const [statusCode, responseDef] of Object.entries(responses)) {
        if (!isObjectRecord(responseDef)) continue;
        const content = responseDef.content;
        if (!isObjectRecord(content)) continue;

        for (const [contentType, mediaTypeDef] of Object.entries(content)) {
          if (!isObjectRecord(mediaTypeDef) || !("schema" in mediaTypeDef))
            continue;

          const ref =
            `${rootId}#/paths/${pointerEscape(pathName)}` +
            `/${pointerEscape(method)}/responses/${pointerEscape(statusCode)}` +
            `/content/${pointerEscape(contentType)}/schema`;

          entries.push({
            key: `${String(method).toUpperCase()} ${pathName} ${statusCode} ${contentType}`,
            ref,
          });
        }
      }
    }
  }

  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

function buildResponseValidatorModule(
  sourceSchema: OpenApiSchema,
  ref: string,
): string {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    code: {
      source: true,
      esm: true,
    },
  });

  const normalizedRefHash = sha256(ref);
  const schemaId = `${COMPILED_SCHEMA_ID_PREFIX}/${normalizedRefHash}.json`;

  ajv.addSchema(sourceSchema, ROOT_SCHEMA_ID);
  ajv.addSchema({ $id: schemaId, $ref: ref }, schemaId);
  ajv.getSchema(schemaId);

  const moduleCode = standaloneCode(ajv, { validate: schemaId });
  return `${moduleCode}\nexport default validate;\n`;
}

async function fetchSchemaForTag(
  tag: string,
): Promise<{ raw: string; parsed: OpenApiSchema; url: string }> {
  const schemaPath = SCHEMA_PATH.replace(/^\/+/, "");
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${tag}/${schemaPath}`;
  const raw = await fetchText(url);
  const parsedUnknown = JSON.parse(raw) as unknown;

  if (!isOpenApiSchema(parsedUnknown)) {
    throw new Error(`Invalid OpenAPI schema for tag ${tag}`);
  }

  return { raw, parsed: parsedUnknown, url };
}

async function compileTag(tag: string, force: boolean): Promise<CompileResult> {
  const tagManifestPath = path.join(TAGS_DIR, `${tag}.json`);
  if (!force) {
    try {
      await readFile(tagManifestPath, "utf8");
      return { tag, changed: false, skipped: true };
    } catch {
      // continue
    }
  }

  const { raw, parsed, url } = await fetchSchemaForTag(tag);
  const normalizedSchema = normalizeOpenApiNullable(parsed);
  const sourceSchema: OpenApiSchema = {
    ...(normalizedSchema as OpenApiSchema),
    $id: ROOT_SCHEMA_ID,
  };
  const responseEntries = collectResponseSchemaEntries(
    sourceSchema,
    ROOT_SCHEMA_ID,
  );

  const keyToHash: Record<string, string> = {};
  let newObjects = 0;

  for (const entry of responseEntries) {
    const moduleCode = buildResponseValidatorModule(sourceSchema, entry.ref);
    const codeHash = sha256(moduleCode);
    keyToHash[entry.key] = codeHash;

    const objectPath = path.join(OBJECTS_DIR, `${codeHash}.mjs`);
    let existed = true;
    try {
      await readFile(objectPath, "utf8");
    } catch {
      existed = false;
    }

    if (!existed || force) {
      const changed = await writeIfChanged(objectPath, moduleCode);
      if (changed && !existed) newObjects += 1;
    }
  }

  const uniqueHashes = new Set(Object.values(keyToHash));
  const tagManifest: TagManifest = {
    source: SOURCE_REPO,
    tag,
    schemaUrl: url,
    schemaHash: sha256(raw),
    openapi: parsed.openapi,
    infoVersion: parsed.info?.version || null,
    validatorCount: responseEntries.length,
    uniqueObjectCount: uniqueHashes.size,
    generatedAt: new Date().toISOString(),
    keyToHash,
  };

  const changed = await writeIfChanged(
    tagManifestPath,
    `${JSON.stringify(tagManifest, null, 2)}\n`,
  );

  return {
    tag,
    changed,
    skipped: false,
    meta: tagManifest,
    newObjects,
  };
}

async function listExistingArtifactTags(): Promise<string[]> {
  try {
    const entries = await readdir(TAGS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .filter((tag) => TAG_RE.test(tag));
  } catch {
    return [];
  }
}

async function loadTagManifest(tag: string): Promise<TagManifest | null> {
  const manifest = await readJson<unknown>(
    path.join(TAGS_DIR, `${tag}.json`),
    null,
  );
  return isTagManifest(manifest) ? manifest : null;
}

function buildVersionModuleSource(
  tag: string,
  tagManifest: TagManifest,
): string {
  const uniqueHashes = Array.from(
    new Set(Object.values(tagManifest.keyToHash)),
  ).sort();
  const imports: string[] = [];
  const hashConstNames: Record<string, string> = {};

  uniqueHashes.forEach((hash, index) => {
    const constName = `h${index}`;
    hashConstNames[hash] = constName;
    imports.push(`import ${constName} from '../objects/${hash}.mjs';`);
  });

  const validatorsByHashLines = uniqueHashes
    .map((hash) => `  ${JSON.stringify(hash)}: ${hashConstNames[hash]}`)
    .join(",\n");

  return `${imports.join("\n")}\n\nexport const tag = ${JSON.stringify(tag)};\nexport const tagMeta = ${JSON.stringify(
    {
      source: tagManifest.source,
      tag: tagManifest.tag,
      schemaUrl: tagManifest.schemaUrl,
      schemaHash: tagManifest.schemaHash,
      openapi: tagManifest.openapi,
      infoVersion: tagManifest.infoVersion,
      validatorCount: tagManifest.validatorCount,
      uniqueObjectCount: tagManifest.uniqueObjectCount,
      generatedAt: tagManifest.generatedAt,
    },
    null,
    2,
  )};\n\nexport const keyToHash = ${JSON.stringify(tagManifest.keyToHash, null, 2)};\n\nconst validatorsByHash = {\n${validatorsByHashLines}\n};\n\nexport function getValidatorByHash(hash) {\n  return validatorsByHash[hash] || null;\n}\n\nexport default {\n  tag,\n  tagMeta,\n  keyToHash,\n  getValidatorByHash\n};\n`;
}

async function regenerateGeneratedRuntime(
  knownTags: Set<string>,
  latestTag: string,
): Promise<void> {
  await mkdir(GENERATED_VERSIONS_DIR, { recursive: true });

  const sortedTags = sortTagsDesc(Array.from(knownTags));
  let latestTagManifest: TagManifest | null = null;

  for (const tag of sortedTags) {
    const tagManifest = await loadTagManifest(tag);
    if (
      !tagManifest ||
      !tagManifest.keyToHash ||
      typeof tagManifest.keyToHash !== "object"
    ) {
      throw new Error(`Missing or invalid tag manifest for ${tag}`);
    }

    const moduleName = tagToModuleName(tag);
    const versionModulePath = path.join(
      GENERATED_VERSIONS_DIR,
      `${moduleName}.mjs`,
    );
    const versionSource = buildVersionModuleSource(tag, tagManifest);
    await writeIfChanged(versionModulePath, versionSource);
    if (tag === latestTag) latestTagManifest = tagManifest;
  }

  const loaderLines = sortedTags
    .map(
      (tag) =>
        `  ${JSON.stringify(tag)}: () => import('./versions/${tagToModuleName(tag)}.mjs')`,
    )
    .join(",\n");

  const loaderSource = `export const availableVersions = ${JSON.stringify(sortedTags)};\nexport const latestVersion = ${JSON.stringify(
    latestTag,
  )};\n\nconst LOADERS = {\n${loaderLines}\n};\n\nexport function hasVersion(tag) {\n  return typeof LOADERS[tag] === 'function';\n}\n\nexport async function loadVersionModule(tag) {\n  const load = LOADERS[tag];\n  if (!load) return null;\n  const mod = await load();\n  return mod.default || mod;\n}\n`;

  await writeIfChanged(GENERATED_VERSION_LOADERS_PATH, loaderSource);
  await writeIfChanged(
    GENERATED_META_PATH,
    `const generatedMeta = ${JSON.stringify(
      {
        source: SOURCE_REPO,
        latestTag,
        availableVersions: sortedTags,
        generatedAt: latestTagManifest?.generatedAt || null,
      },
      null,
      2,
    )};\n\nexport default generatedMeta;\n`,
  );
}

async function loadManifest(): Promise<BuildManifest> {
  return readJson<BuildManifest>(MANIFEST_PATH, {
    source: SOURCE_REPO,
    schemaPath: SCHEMA_PATH,
    latestTag: null,
    updatedAt: null,
    missingSchemaCutoffTag: null,
    tags: {},
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await loadSourceConfig(args.configFile);
  assertConfig();
  const manifest = await loadManifest();
  if (manifest.source !== SOURCE_REPO || manifest.schemaPath !== SCHEMA_PATH) {
    manifest.missingSchemaCutoffTag = null;
  }

  if (args.tag && !TAG_RE.test(args.tag)) {
    throw new Error("`--tag` must match v<major>.<minor>.<patch>");
  }

  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await mkdir(OBJECTS_DIR, { recursive: true });
  await mkdir(TAGS_DIR, { recursive: true });

  let tagsToProcess: string[] = [];
  const cachedReleaseTags = Array.isArray(manifest.releaseTags)
    ? manifest.releaseTags
    : [];
  const cachedReleasesEtag =
    typeof manifest.releasesEtag === "string" && manifest.releasesEtag.trim()
      ? manifest.releasesEtag
      : null;

  if (args.tag) {
    if (args.requireRelease) {
      const isRelease = await isPublishedReleaseTag(args.tag);
      if (!isRelease) {
        console.log(
          `Skipping ${args.tag}: not a published non-prerelease GitHub release tag.`,
        );
        return;
      }
    }
    tagsToProcess = [args.tag];
  } else if (args.syncTags) {
    const releaseResult = await listReleaseTags(cachedReleasesEtag);
    let allTags: string[] = [];
    if (releaseResult.notModified) {
      if (cachedReleaseTags.length > 0) {
        allTags = sortTagsDesc(cachedReleaseTags);
      } else {
        const fallback = await listReleaseTags(null);
        allTags = fallback.tags;
        manifest.releasesEtag = fallback.etag;
        manifest.releaseTags = fallback.tags;
      }
    } else {
      allTags = releaseResult.tags;
      if (!sameStringArray(cachedReleaseTags, releaseResult.tags)) {
        manifest.releasesEtag = releaseResult.etag;
        manifest.releaseTags = releaseResult.tags;
      }
    }
    const existing = new Set(await listExistingArtifactTags());
    const cutoffTag =
      typeof manifest.missingSchemaCutoffTag === "string" &&
      TAG_RE.test(manifest.missingSchemaCutoffTag)
        ? manifest.missingSchemaCutoffTag
        : null;
    const boundedTags = cutoffTag
      ? allTags.filter((tag) => compareTags(tag, cutoffTag) > 0)
      : allTags;
    if (cutoffTag) {
      console.log(
        `Using missing-schema cutoff at ${cutoffTag}; skipping that and older tags during sync.`,
      );
    }
    const candidateTags = args.limit
      ? boundedTags.slice(0, args.limit)
      : boundedTags;
    tagsToProcess = candidateTags.filter(
      (tag) => !existing.has(tag) || args.force,
    );
  } else {
    const releaseResult = await listReleaseTags(cachedReleasesEtag);
    let latestTags: string[] = [];
    if (releaseResult.notModified) {
      if (cachedReleaseTags.length > 0) {
        latestTags = sortTagsDesc(cachedReleaseTags).slice(0, 1);
      } else {
        const fallback = await listReleaseTags(null);
        latestTags = fallback.tags.slice(0, 1);
        manifest.releasesEtag = fallback.etag;
        manifest.releaseTags = fallback.tags;
      }
    } else {
      latestTags = releaseResult.tags.slice(0, 1);
      if (!sameStringArray(cachedReleaseTags, releaseResult.tags)) {
        manifest.releasesEtag = releaseResult.etag;
        manifest.releaseTags = releaseResult.tags;
      }
    }
    const [latest] = latestTags;
    tagsToProcess = latest ? [latest] : [];
  }

  let hitMissingSchemaCutoffTag: string | null = null;
  const existingBeforeRun = new Set(await listExistingArtifactTags());
  let havePriorTag = existingBeforeRun.size > 0;
  for (const tag of tagsToProcess) {
    try {
      const result = await compileTag(tag, args.force);
      if (result.skipped) {
        console.log(`Skipped ${tag} (already compiled)`);
      } else if ("meta" in result) {
        console.log(
          `Compiled ${tag} (${result.meta.validatorCount} validators, ${result.newObjects} new shared objects)`,
        );
      }
      havePriorTag = true;
    } catch (error: unknown) {
      if (isMissingSchemaForTagError(error)) {
        if (havePriorTag) {
          hitMissingSchemaCutoffTag = tag;
          console.log(
            `Stopping tag sync at ${tag}: schema file not found for this and likely older tags (${error.url}).`,
          );
          break;
        }
        throw new Error(
          `Schema file missing for ${tag} (${error.url}). No prior tag artifacts were available, so aborting.`,
        );
      }
      throw error;
    }
  }

  const knownTags = new Set(await listExistingArtifactTags());
  if (knownTags.size === 0) {
    console.log("No artifacts available after processing.");
    return;
  }

  const latestTag = sortTagsDesc(Array.from(knownTags))[0] as string;
  await regenerateGeneratedRuntime(knownTags, latestTag);

  manifest.source = SOURCE_REPO;
  manifest.schemaPath = SCHEMA_PATH;
  manifest.latestTag = latestTag;
  manifest.missingSchemaCutoffTag =
    hitMissingSchemaCutoffTag ?? manifest.missingSchemaCutoffTag ?? null;
  manifest.tags = {};
  let latestGeneratedAt: string | null = null;

  for (const tag of sortTagsDesc(Array.from(knownTags))) {
    const tagManifest = await loadTagManifest(tag);
    if (!tagManifest) continue;
    manifest.tags[tag] = {
      schemaHash: tagManifest.schemaHash,
      validatorCount: tagManifest.validatorCount,
      uniqueObjectCount: tagManifest.uniqueObjectCount,
      generatedAt: tagManifest.generatedAt,
    };
    if (tag === latestTag) latestGeneratedAt = tagManifest.generatedAt;
  }
  manifest.updatedAt = latestGeneratedAt || manifest.updatedAt || null;

  await writeIfChanged(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  if (tagsToProcess.length === 0) {
    console.log(`No new release tags. Current remains ${latestTag}`);
  }
  console.log(`Latest compiled tag: ${latestTag}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
