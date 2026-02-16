import {
  availableVersions,
  generatedMeta,
  hasVersion,
  latestVersion,
  loadTypedVersionModule,
  type VersionRuntime,
} from "./artifacts-runtime";

const RESPONSE_KEY_SPLITTER = ";";
const versionModuleCache = new Map<string, VersionRuntime>();

interface ValidatorError {
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
  message?: string;
  params?: unknown;
}

type ValidatorFn = ((payload: unknown) => boolean) & {
  errors?: ValidatorError[] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRequestedVersion(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getVersionRuntime(
  tag: string | null,
): Promise<VersionRuntime | null> {
  const resolved = normalizeRequestedVersion(tag) || latestVersion;
  if (!resolved) return null;

  const cached = versionModuleCache.get(resolved);
  if (cached) return cached;

  if (!hasVersion(resolved)) {
    return null;
  }

  const runtime = await loadTypedVersionModule(resolved);
  if (!runtime) return null;

  versionModuleCache.set(resolved, runtime);
  return runtime;
}

function findResponseValidator(
  versionRuntime: VersionRuntime,
  pathname: string,
  method: string,
  statusCode: string | number,
  contentType: string,
): ValidatorFn | null {
  const methodUpper = method.toUpperCase();
  const statusText = String(statusCode);
  const normalizedContentType =
    contentType.split(RESPONSE_KEY_SPLITTER, 1)[0]?.trim().toLowerCase() ||
    "application/json";

  const responseKeys = [statusText, `${statusText.charAt(0)}XX`, "default"];
  const contentTypeKeys = [normalizedContentType, "application/json", "*/*"];

  for (const responseKey of responseKeys) {
    for (const mediaType of contentTypeKeys) {
      const key = `${methodUpper} ${pathname} ${responseKey} ${mediaType}`;
      const validatorRef = versionRuntime.keyToValidatorRef[key];
      if (!validatorRef) continue;
      const validator = versionRuntime.getValidatorByRef(validatorRef);
      if (typeof validator === "function") {
        return validator as ValidatorFn;
      }
    }
  }

  return null;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function extractRequestedVersion(
  request: Request,
  url: URL,
  body: Record<string, unknown> | null,
): string | null {
  return (
    normalizeRequestedVersion(body?.version) ||
    normalizeRequestedVersion(url.searchParams.get("version")) ||
    normalizeRequestedVersion(request.headers.get("x-openapi-version"))
  );
}

async function handleValidateResponse(
  request: Request,
  url: URL,
): Promise<Response> {
  let bodyUnknown: unknown;
  try {
    bodyUnknown = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!isRecord(bodyUnknown)) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400);
  }

  const pathname = bodyUnknown.path;
  const method = bodyUnknown.method;
  const statusCode = bodyUnknown.status;
  const payload = bodyUnknown.payload;
  const contentType =
    typeof bodyUnknown.contentType === "string"
      ? bodyUnknown.contentType
      : "application/json";
  const requestedVersion = extractRequestedVersion(request, url, bodyUnknown);

  if (
    typeof pathname !== "string" ||
    typeof method !== "string" ||
    !(
      typeof statusCode === "string" ||
      (typeof statusCode === "number" && Number.isInteger(statusCode))
    )
  ) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400);
  }

  const versionRuntime = await getVersionRuntime(requestedVersion);
  if (!versionRuntime) {
    return jsonResponse(
      {
        ok: false,
        error: "unknown_version",
        requestedVersion: requestedVersion || latestVersion || null,
        latestVersion,
        availableVersions,
      },
      404,
    );
  }

  const validator = findResponseValidator(
    versionRuntime,
    pathname,
    method,
    statusCode,
    contentType,
  );
  if (!validator) {
    return jsonResponse(
      {
        ok: false,
        error: "schema_not_found",
        version: versionRuntime.tag || requestedVersion || latestVersion,
      },
      404,
    );
  }

  const valid = validator(payload);
  if (valid) {
    return jsonResponse({
      ok: true,
      valid: true,
      version: versionRuntime.tag || requestedVersion || latestVersion,
    });
  }

  return jsonResponse(
    {
      ok: true,
      valid: false,
      version: versionRuntime.tag || requestedVersion || latestVersion,
      errors: (validator.errors || []).map((err) => ({
        instancePath: err.instancePath,
        schemaPath: err.schemaPath,
        keyword: err.keyword,
        message: err.message,
        params: err.params,
      })),
    },
    422,
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/meta") {
      const requestedVersion = extractRequestedVersion(request, url, null);
      const versionRuntime = await getVersionRuntime(requestedVersion);
      return jsonResponse({
        ok: true,
        source: generatedMeta.source,
        latestTag: generatedMeta.latestTag,
        availableVersions,
        requestedVersion: requestedVersion || null,
        resolvedVersion: versionRuntime?.tag || latestVersion || null,
        versionMeta: versionRuntime?.tagMeta || null,
      });
    }

    if (request.method === "POST" && url.pathname === "/validate-response") {
      return handleValidateResponse(request, url);
    }

    if (request.method === "GET" && url.pathname === "/versions") {
      return jsonResponse({ ok: true, latestVersion, availableVersions });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({
        ok: true,
        status: "ready",
        latestVersion,
        versions: availableVersions.length,
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "not_found",
        routes: [
          "GET /healthz",
          "GET /meta",
          "GET /versions",
          "POST /validate-response",
        ],
      },
      404,
    );
  },
};
