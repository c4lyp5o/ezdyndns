import { describe, expect, it } from "bun:test";

// Pure-logic unit tests for the deSEC (dedyn) adapter: scope convention and the
// hostname normalization the update endpoint needs. No network, no db.
process.env.EZDYNDNS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { dedynScope } = await import("../services/dedyn");

describe("dedynScope", () => {
	it("clamps TTL to the deSEC minimum for short intervals", () => {
		expect(dedynScope({ interval_sec: 30 })).toBe("domain 60 update 60 ttl 60 ip4 60");
	});

	it("clamps TTL to the deSEC maximum for long intervals", () => {
		expect(dedynScope({ interval_sec: 3600 })).toBe("domain 240 update 240 ttl 240 ip4 240");
	});

	it("uses the interval itself when in range", () => {
		expect(dedynScope({ interval_sec: 300 })).toBe("domain 240 update 240 ttl 240 ip4 240");
		expect(dedynScope({ interval_sec: 120 })).toBe("domain 120 update 120 ttl 120 ip4 120");
	});

	it("defaults to 300 -> 240 when unset", () => {
		expect(dedynScope({})).toBe("domain 240 update 240 ttl 240 ip4 240");
	});
});

const { updateDedyn } = await import("../services/dedyn");

describe("updateDedyn", () => {
	it("fails without a stored token", async () => {
		const res = await updateDedyn({ username: null }, { hostname: "@", domainname: "a.dedyn.io" }, "1.2.3.4");
		expect(res.ok).toBe(false);
		expect(res.detail).toContain("token");
	});
});

const { PROVIDERS, verifyProvider } = await import("../services/providers");

describe("PROVIDERS", () => {
	it("includes dedyn", () => {
		expect(PROVIDERS).toContain("dedyn");
	});

	it("rejects an unknown provider", async () => {
		const r = await verifyProvider({ provider: "nope", username: "x" });
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("unknown provider");
	});

	it("rejects an empty deSEC token without calling out", async () => {
		const r = await verifyProvider({ provider: "dedyn", username: "" });
		expect(r.ok).toBe(false);
	});
});
