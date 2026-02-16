// @ts-expect-error Generated artifact module has no static .d.ts.
import generatedMetaRaw from "../artifacts/meta.mjs";
// @ts-expect-error Generated artifact module has no static .d.ts.
import * as versionLoadersRaw from "../artifacts/versionLoaders.mjs";

interface GeneratedMeta {
  source: string;
  latestTag: string | null;
  availableVersions: string[];
  generatedAt: string | null;
}

export interface VersionRuntime {
  tag?: string;
  tagMeta?: unknown;
  keyToHash: Record<string, string>;
  getValidatorByHash: (hash: string) => unknown;
}

interface VersionLoadersRuntime {
  availableVersions: string[];
  hasVersion: (tag: string) => boolean;
  latestVersion: string | null;
  loadVersionModule: (tag: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeGeneratedMeta(value: unknown): GeneratedMeta {
  if (!isRecord(value)) {
    return {
      source: "unknown",
      latestTag: null,
      availableVersions: [],
      generatedAt: null,
    };
  }

  return {
    source: typeof value.source === "string" ? value.source : "unknown",
    latestTag: typeof value.latestTag === "string" ? value.latestTag : null,
    availableVersions: toStringArray(value.availableVersions),
    generatedAt:
      typeof value.generatedAt === "string" ? value.generatedAt : null,
  };
}

function normalizeVersionLoaders(value: unknown): VersionLoadersRuntime {
  if (!isRecord(value)) {
    return {
      availableVersions: [],
      hasVersion: () => false,
      latestVersion: null,
      loadVersionModule: async () => null,
    };
  }

  return {
    availableVersions: toStringArray(value.availableVersions),
    hasVersion:
      typeof value.hasVersion === "function"
        ? (value.hasVersion as (tag: string) => boolean)
        : () => false,
    latestVersion:
      typeof value.latestVersion === "string" ? value.latestVersion : null,
    loadVersionModule:
      typeof value.loadVersionModule === "function"
        ? (value.loadVersionModule as (tag: string) => Promise<unknown>)
        : async () => null,
  };
}

function normalizeVersionRuntime(value: unknown): VersionRuntime | null {
  if (!isRecord(value)) return null;
  if (
    !isRecord(value.keyToHash) ||
    typeof value.getValidatorByHash !== "function"
  ) {
    return null;
  }

  const keyToHash: Record<string, string> = {};
  for (const [k, v] of Object.entries(value.keyToHash)) {
    if (typeof v === "string") keyToHash[k] = v;
  }

  return {
    tag: typeof value.tag === "string" ? value.tag : undefined,
    tagMeta: value.tagMeta,
    keyToHash,
    getValidatorByHash: value.getValidatorByHash as (hash: string) => unknown,
  };
}

const versionLoaders = normalizeVersionLoaders(versionLoadersRaw);

export const generatedMeta = normalizeGeneratedMeta(generatedMetaRaw);
export const availableVersions = versionLoaders.availableVersions;
export const latestVersion = versionLoaders.latestVersion;
export const hasVersion = versionLoaders.hasVersion;

export async function loadTypedVersionModule(
  tag: string,
): Promise<VersionRuntime | null> {
  const loaded = await versionLoaders.loadVersionModule(tag);
  return normalizeVersionRuntime(loaded);
}
