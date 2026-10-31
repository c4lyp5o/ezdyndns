import { afterEach, describe, expect, it } from "bun:test";

// Adapter contracts for the providers added in 0.2.0, against a stubbed fetch:
// what each sends and how each reads the reply. No network, temp db (setup.js).
const { encryptSecret } = await import("../crypto");
const { CATALOG, PROVIDERS, verifyCredentialChange, verifyProvider, updateRecord } = await import(
	"../services/providers"
);
const { duckSubname } = await import("../services/duckdns");
const { afraidToken } = await import("../services/afraid");
const { validateRecord } = await import("../routes/api");

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

// Answers calls in order and records them.
function stub(...replies) {
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
		const [status, body] = replies.shift() ?? [500, ""];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	};
	return calls;
}

const svc = (provider, creds) => ({
	provider,
	username: creds.username ? encryptSecret(creds.username) : null,
	password: creds.password ? encryptSecret(creds.password) : null,
});

describe("catalog", () => {
	it("lists every provider with an adapter and at least one credential field", () => {
		expect(PROVIDERS).toEqual([
			"namecheap",
			"cloudflare",
			"dedyn",
			"duckdns",
			"porkbun",
			"digitalocean",
			"gandi",
			"afraid",
			"noip",
			"dyndns2",
		]);
		for (const id of PROVIDERS) expect(CATALOG[id].fields.length).toBeGreaterThan(0);
	});
});

describe("duckdns", () => {
	it("reads the subname from host + duckdns.org or from the full name", () => {
		expect(duckSubname({ hostname: "home", domainname: "duckdns.org" })).toBe("home");
		expect(duckSubname({ hostname: "@", domainname: "home.duckdns.org" })).toBe("home");
		expect(duckSubname({ hostname: "home", domainname: "example.com" })).toBeNull();
	});

	it("sends the subname and ip, and maps NOCHANGE to nochg", async () => {
		const calls = stub([200, "OK\n203.0.113.9\n\nNOCHANGE"]);
		const r = await updateRecord(svc("duckdns", { username: "tok" }), { hostname: "home", domainname: "duckdns.org" }, "203.0.113.9");
		expect(r).toEqual({ ok: true, detail: "nochg" });
		const u = new URL(calls[0].url);
		expect(u.searchParams.get("domains")).toBe("home");
		expect(u.searchParams.get("ip")).toBe("203.0.113.9");
	});

	it("reports KO without echoing the token", async () => {
		stub([200, "KO"]);
		const r = await updateRecord(svc("duckdns", { username: "secret-tok" }), { hostname: "home", domainname: "duckdns.org" }, "1.2.3.4");
		expect(r.ok).toBe(false);
		expect(r.detail).not.toContain("secret-tok");
	});
});

describe("porkbun", () => {
	const domain = { hostname: "home", domainname: "example.com" };

	it("sends keys as headers and skips the write when the record already matches", async () => {
		const calls = stub([200, { status: "SUCCESS", records: [{ content: "1.2.3.4" }] }]);
		const r = await updateRecord(svc("porkbun", { username: "pk1", password: "sk1" }), domain, "1.2.3.4");
		expect(r.detail).toBe("nochg");
		expect(calls[0].url).toBe("https://api.porkbun.com/api/json/v3/dns/retrieveByNameType/example.com/A/home");
		expect(calls[0].headers["X-API-Key"]).toBe("pk1");
		expect(calls[0].headers["X-Secret-API-Key"]).toBe("sk1");
	});

	it("edits by name and type when the IP differs", async () => {
		const calls = stub([200, { status: "SUCCESS", records: [{ content: "9.9.9.9" }] }], [200, { status: "SUCCESS" }]);
		const r = await updateRecord(svc("porkbun", { username: "pk1", password: "sk1" }), domain, "1.2.3.4");
		expect(r.ok).toBe(true);
		expect(calls[1].url).toContain("/dns/editByNameType/example.com/A/home");
		expect(calls[1].body).toEqual({ content: "1.2.3.4" });
	});

	it("creates an apex record with an empty name", async () => {
		const calls = stub([200, { status: "SUCCESS", records: [] }], [200, { status: "SUCCESS", id: "1" }]);
		const r = await updateRecord(svc("porkbun", { username: "pk1", password: "sk1" }), { hostname: "@", domainname: "example.com" }, "1.2.3.4");
		expect(r.detail).toBe("created A example.com -> 1.2.3.4");
		expect(calls[0].url).toBe("https://api.porkbun.com/api/json/v3/dns/retrieveByNameType/example.com/A");
		expect(calls[1].body).toEqual({ name: "", type: "A", content: "1.2.3.4" });
	});

	it("explains a domain without API access", async () => {
		stub([200, { status: "SUCCESS" }], [400, { status: "ERROR", code: "API_ACCESS_DISABLED", message: "x" }]);
		const r = await verifyProvider({ provider: "porkbun", username: "pk1", password: "sk1", ...domain });
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("API access is off");
	});

	it("re-verifies a replaced secret with the stored API key", async () => {
		const calls = stub([200, { status: "SUCCESS" }]);
		const r = await verifyCredentialChange(svc("porkbun", { username: "pk-stored", password: "sk-old" }), null, { password: "sk-new" });
		expect(r.ok).toBe(true);
		expect(calls[0].headers["X-API-Key"]).toBe("pk-stored");
		expect(calls[0].headers["X-Secret-API-Key"]).toBe("sk-new");
	});
});

describe("digitalocean", () => {
	const domain = { hostname: "home", domainname: "example.com" };

	it("filters on the full name and patches the found record", async () => {
		const calls = stub([200, { domain_records: [{ id: 7, data: "9.9.9.9" }] }], [200, { domain_record: {} }]);
		const r = await updateRecord(svc("digitalocean", { username: "dop" }), domain, "1.2.3.4");
		expect(r.detail).toBe("updated A home.example.com -> 1.2.3.4");
		expect(calls[0].url).toBe("https://api.digitalocean.com/v2/domains/example.com/records?type=A&name=home.example.com");
		expect(calls[0].headers.Authorization).toBe("Bearer dop");
		expect(calls[1]).toMatchObject({ method: "PATCH", body: { type: "A", data: "1.2.3.4" } });
		expect(calls[1].url).toEndWith("/records/7");
	});

	it("creates a missing record with the subname", async () => {
		const calls = stub([200, { domain_records: [] }], [201, { domain_record: {} }]);
		await updateRecord(svc("digitalocean", { username: "dop" }), domain, "1.2.3.4");
		expect(calls[1]).toMatchObject({ method: "POST", body: { type: "A", name: "home", data: "1.2.3.4" } });
	});

	it("names a domain the account does not hold", async () => {
		stub([200, { account: {} }], [404, { id: "not_found" }]);
		const r = await verifyProvider({ provider: "digitalocean", username: "dop", ...domain });
		expect(r.detail).toContain("not a domain in this DigitalOcean account");
	});
});

describe("gandi", () => {
	it("PUTs the rrset with a 300 s TTL when it differs", async () => {
		const calls = stub([200, { rrset_values: ["9.9.9.9"] }], [201, { message: "DNS Record Created" }]);
		const r = await updateRecord(svc("gandi", { username: "pat" }), { hostname: "@", domainname: "example.com" }, "1.2.3.4");
		expect(r.ok).toBe(true);
		expect(calls[1].url).toBe("https://api.gandi.net/v5/livedns/domains/example.com/records/%40/A");
		expect(calls[1]).toMatchObject({ method: "PUT", body: { rrset_values: ["1.2.3.4"], rrset_ttl: 300 } });
	});

	it("treats 404 on read as a record to create", async () => {
		stub([404, {}], [201, {}]);
		const r = await updateRecord(svc("gandi", { username: "pat" }), { hostname: "home", domainname: "example.com" }, "1.2.3.4");
		expect(r.detail).toBe("created A home.example.com -> 1.2.3.4");
	});
});

describe("afraid", () => {
	const domain = { hostname: "home", domainname: "mooo.com", password: null };

	it("takes a pasted update URL or a bare token", () => {
		expect(afraidToken("https://freedns.afraid.org/dynamic/update.php?dGVzdHRva2Vu")).toBe("dGVzdHRva2Vu");
		expect(afraidToken("dGVzdHRva2Vu")).toBe("dGVzdHRva2Vu");
		expect(afraidToken("not a token")).toBeNull();
	});

	it("sends address= and accepts an Updated reply naming the record", async () => {
		const calls = stub([200, "Updated 1 host(s) home.mooo.com to 1.2.3.4 in 0.2 seconds"]);
		const r = await updateRecord(svc("afraid", { password: "dGVzdHRva2Vu" }), domain, "1.2.3.4");
		expect(r.ok).toBe(true);
		expect(calls[0].url).toBe("https://freedns.afraid.org/dynamic/update.php?dGVzdHRva2Vu&address=1.2.3.4");
	});

	it("prefers the record's own token", async () => {
		const calls = stub([200, "Address 1.2.3.4 has not changed."]);
		const r = await updateRecord(svc("afraid", { password: "c2VydmljZXRvaw" }), { ...domain, password: encryptSecret("cmVjb3JkdG9r") }, "1.2.3.4");
		expect(r.detail).toBe("nochg");
		expect(calls[0].url).toContain("update.php?cmVjb3JkdG9r&");
	});

	it("refuses an update that moved a different record", async () => {
		stub([200, "Updated 1 host(s) other.mooo.com to 1.2.3.4 in 0.2 seconds"]);
		const r = await updateRecord(svc("afraid", { password: "dGVzdHRva2Vu" }), domain, "1.2.3.4");
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("another record");
	});
});

describe("validateRecord", () => {
	it("needs a per-record token for a second FreeDNS record", () => {
		expect(validateRecord({ provider: "afraid" }, { hostname: "b", domainname: "mooo.com" }, 1)).toContain("own update token");
		expect(validateRecord({ provider: "afraid" }, { hostname: "b", domainname: "mooo.com", password: "t" }, 1)).toBeNull();
	});

	it("rejects a Duck DNS record outside duckdns.org", () => {
		expect(validateRecord({ provider: "duckdns" }, { hostname: "home", domainname: "example.com" })).toContain("duckdns.org");
	});
});
