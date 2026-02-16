import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("validator via service binding", () => {
  it("serves health checks through the SELF service binding", async () => {
    const response = await SELF.fetch("https://validator.internal/healthz");

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      status: string;
      latestVersion: string | null;
      versions: number;
    };

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("ready");
    expect(typeof payload.versions).toBe("number");
  });

  it("returns not_found payload for unknown routes through the same binding", async () => {
    const response = await SELF.fetch("https://validator.internal/nope");

    expect(response.status).toBe(404);

    const payload = (await response.json()) as {
      ok: boolean;
      error: string;
      routes: string[];
    };

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("not_found");
    expect(payload.routes).toContain("GET /healthz");
  });
});
