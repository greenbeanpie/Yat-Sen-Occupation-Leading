import { describe, expect, it } from "vitest";
import { request } from "./helpers";

const ALLOWED_ORIGIN = "http://localhost:5173";
const BLOCKED_ORIGIN = "https://untrusted.example";

describe("CORS", () => {
  it("returns the allowlisted origin on API responses", async () => {
    const res = await request(undefined, "/session", { headers: { Origin: ALLOWED_ORIGIN } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("answers allowlisted preflight requests", async () => {
    const res = await request(undefined, "/session", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("does not grant access to an unlisted origin", async () => {
    const res = await request(undefined, "/session", { headers: { Origin: BLOCKED_ORIGIN } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
