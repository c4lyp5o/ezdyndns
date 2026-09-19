import { describe, expect, it } from "bun:test";

// Unit tests for the pure crypto + sanitize layer (no server, no network).
process.env.EZDYNDNS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.EZDYNDNS_TOKEN = "test-token";

const { encryptSecret, decryptSecret } = await import("../crypto");

describe("crypto", () => {
	it("round-trips a provider secret", () => {
		const enc = encryptSecret("namecheap-ddns-key-123");
		expect(enc).toStartWith("v1:");
		expect(enc).not.toContain("namecheap");
		expect(decryptSecret(enc)).toBe("namecheap-ddns-key-123");
	});

	it("uses a unique IV per encryption", () => {
		expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
	});

	it("handles empty value as null", () => {
		expect(encryptSecret("")).toBeNull();
		expect(decryptSecret(null)).toBeNull();
	});
});

const { sanitizeService } = await import("../db");

describe("sanitizeService", () => {
	it("masks username and password", () => {
		const out = sanitizeService({ username: "enc", password: "enc", name: "x" });
		expect(out.username).toBe("********");
		expect(out.password).toBe("********");
		expect(out.name).toBe("x");
	});

	it("leaves null creds null", () => {
		const out = sanitizeService({ username: null, password: null, name: "x" });
		expect(out.username).toBeNull();
		expect(out.password).toBeNull();
	});
});
