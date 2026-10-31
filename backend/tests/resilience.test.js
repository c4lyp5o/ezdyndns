import { afterEach, describe, expect, it } from "bun:test";

// 0.3.0: IP agreement, holds and back-off, push-on-change, AAAA, dyndns2,
// notifications, the toolbox's parsing, and the scheduler end to end against a
// stubbed network. Temp db via setup.js; resolution checks are off there.
const db = await import("../db");
const { encryptSecret } = await import("../crypto");
const { decide } = await import("../services/ipcheck");
const { readReply, updateUrl } = await import("../services/dyndns2");
const { updateRecord } = await import("../services/providers");
const { channels } = await import("../services/notify");
const { cleanName, decodeTxt, encodeQuery, parseSpf, parseTags, verdictFor } = await import("../services/dnstools");
const { toolQuery, updatesCsv, validateRecord } = await import("../routes/api");
const { checkOnce, pushDomainNow } = await import("../scheduler");

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

// Routes stubbed requests by hostname; records every call.
function network(handlers) {
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		calls.push({ url, init });
		const h = handlers[url.hostname];
		if (!h) return new Response("", { status: 503 });
		const [status, body, headers] = h(url, init);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
	};
	return calls;
}
const ipSources = (ip) => ({
	"ipinfo.io": () => [200, { ip }],
	"api.ipify.org": () => [200, { ip }],
});

describe("IP agreement", () => {
	it("takes an address two sources agree on", () => {
		expect(decide([{ name: "a", ip: "1.1.1.1" }, { name: "b", ip: "1.1.1.1" }, { name: "c", ip: "9.9.9.9" }], null)).toMatchObject({
			ip: "1.1.1.1",
			agreed: 2,
		});
	});

	it("refuses a tie and a lone new answer", () => {
		expect(() => decide([{ name: "a", ip: "1.1.1.1" }, { name: "b", ip: "2.2.2.2" }], null)).toThrow("disagree");
		expect(() => decide([{ name: "a", ip: "1.1.1.1" }], "2.2.2.2")).toThrow();
		expect(() => decide([], null)).toThrow("all IP check services failed");
	});

	it("accepts a lone answer that matches the last known IP", () => {
		expect(decide([{ name: "a", ip: "1.1.1.1" }], "1.1.1.1").ip).toBe("1.1.1.1");
	});
});

describe("dyndns2", () => {
	it("maps reply codes to ok, hard and retry-later", () => {
		expect(readReply("good 1.2.3.4")).toMatchObject({ ok: true });
		expect(readReply("nochg 1.2.3.4")).toEqual({ ok: true, detail: "nochg" });
		for (const code of ["badauth", "nohost", "abuse", "!donator", "badagent", "notfqdn", "numhost"])
			expect(readReply(code)).toMatchObject({ ok: false, hard: true });
		expect(readReply("911")).toMatchObject({ ok: false, retryAfter: 1800 });
	});

	it("turns a bare server into an https /nic/update URL", () => {
		expect(updateUrl("members.dyndns.org")).toBe("https://members.dyndns.org/nic/update");
		expect(updateUrl("https://api.dynu.com/nic/update")).toBe("https://api.dynu.com/nic/update");
		expect(updateUrl("")).toBeNull();
	});

	it("sends Basic auth and myipv6 for an AAAA record", async () => {
		const calls = network({ "dynupdate.no-ip.com": () => [200, "good 2001:db8::1"] });
		const svc = { provider: "noip", username: encryptSecret("me@example.com"), password: encryptSecret("pw") };
		const r = await updateRecord(svc, { hostname: "home", domainname: "ddns.net", record_type: "AAAA" }, "2001:db8::1");
		expect(r.ok).toBe(true);
		expect(calls[0].url.searchParams.get("myipv6")).toBe("2001:db8::1");
		expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from("me@example.com:pw").toString("base64")}`);
		expect(calls[0].init.headers["User-Agent"]).toMatch(/^ezdyndns ezdyndns\/\d/);
	});
});

describe("adapters", () => {
	it("deSEC keeps the other address family with preserve", async () => {
		const calls = network({ "update.dedyn.io": () => [200, "good"] });
		const svc = { provider: "dedyn", username: encryptSecret("tok"), interval_sec: 300 };
		await updateRecord(svc, { hostname: "@", domainname: "x.dedyn.io", record_type: "A" }, "1.2.3.4");
		await updateRecord(svc, { hostname: "@", domainname: "x.dedyn.io", record_type: "AAAA" }, "2001:db8::1");
		expect(calls[0].url.searchParams.get("myipv4")).toBe("1.2.3.4");
		expect(calls[0].url.searchParams.get("myipv6")).toBe("preserve");
		expect(calls[1].url.searchParams.get("myipv4")).toBe("preserve");
		expect(calls[1].url.searchParams.get("myipv6")).toBe("2001:db8::1");
	});

	it("marks rejected credentials hard and rate limits retry-later", async () => {
		network({ "api.cloudflare.com": () => [403, { success: false }] });
		const cf = { provider: "cloudflare", username: encryptSecret("t") };
		expect(await updateRecord(cf, { hostname: "a", domainname: "b.com" }, "1.2.3.4")).toMatchObject({ hard: true });

		network({ "api.digitalocean.com": () => [429, { id: "too_many_requests" }, { "retry-after": "90" }] });
		const dov = { provider: "digitalocean", username: encryptSecret("t") };
		expect(await updateRecord(dov, { hostname: "a", domainname: "b.com" }, "1.2.3.4")).toMatchObject({ retryAfter: 90 });
	});

	it("refuses AAAA on a provider without IPv6", async () => {
		const r = await updateRecord({ provider: "namecheap" }, { hostname: "a", domainname: "b.com", record_type: "AAAA" }, "2001:db8::1");
		expect(r).toMatchObject({ ok: false, hard: true });
		expect(validateRecord({ provider: "namecheap" }, { hostname: "a", domainname: "b.com", record_type: "AAAA" })).toContain("AAAA");
	});
});

describe("holds and history", () => {
	it("counts a fail streak without skipped cycles and clears only wait holds", () => {
		const sid = db.createService({ name: "streak", provider: "cloudflare", username: "t" });
		const did = db.addDomain(sid, { hostname: "s", domainname: "example.com" });
		db.logUpdate(sid, did, { new_ip: "1.1.1.1", ok: true });
		db.logUpdate(sid, did, { new_ip: "1.1.1.1", ok: false });
		db.logUpdate(sid, did, { new_ip: "1.1.1.1", ok: "skipped" });
		db.logUpdate(sid, did, { new_ip: "1.1.1.1", ok: false });
		expect(db.failStreak(did)).toBe(2);

		db.setHold(did, { kind: "wait", seconds: 600, reason: "slow down" });
		expect(db.isHeld(db.getDomain(did))).toBe(true);
		db.clearWaitHolds();
		expect(db.isHeld(db.getDomain(did))).toBe(false);
		db.setHold(did, { kind: "hard", reason: "bad token" });
		db.clearWaitHolds();
		expect(db.getDomain(did).hold_kind).toBe("hard");
	});

	it("deletes a service's records and history", () => {
		const sid = db.createService({ name: "gone", provider: "cloudflare", username: "t" });
		const did = db.addDomain(sid, { hostname: "g", domainname: "example.com" });
		db.logUpdate(sid, did, { new_ip: "1.1.1.1", ok: true });
		db.deleteService(sid);
		expect(db.getDomain(did)).toBeNull();
		expect(db.countUpdates({ domainId: did })).toBe(0);
	});

	it("allows an A and an AAAA for the same name, and edits in place", () => {
		const sid = db.createService({ name: "dual", provider: "cloudflare", username: "t" });
		db.addDomain(sid, { hostname: "d", domainname: "example.com" });
		const v6 = db.addDomain(sid, { hostname: "d", domainname: "example.com", record_type: "AAAA" });
		db.updateDomain(sid, v6, { hostname: "e", domainname: "example.com", record_type: "AAAA" });
		expect(db.getDomain(v6)).toMatchObject({ hostname: "e", record_type: "AAAA" });
	});
});

describe("scheduler", () => {
	it("holds a record after a hard failure, skips it, and Retry clears it", async () => {
		const sid = db.createService({ name: "duck", provider: "duckdns", username: "duck-token" });
		const did = db.addDomain(sid, { hostname: "home", domainname: "duckdns.org" });
		network({ ...ipSources("198.51.100.7"), "www.duckdns.org": () => [200, "KO"] });

		await checkOnce();
		expect(db.getDomain(did).hold_kind).toBe("hard");
		await checkOnce();
		const [last] = db.recentUpdates(1, { domainId: did });
		expect(last).toMatchObject({ ok: 2 });
		expect(last.detail).toStartWith("held:");

		network({ ...ipSources("198.51.100.7"), "www.duckdns.org": () => [200, "OK\n198.51.100.7\n\nUPDATED"] });
		expect((await pushDomainNow(did)).ok).toBe(true);
		expect(db.getDomain(did).hold_kind).toBeNull();
		db.deleteService(sid);
	});

	it("pushes nothing when the IP sources disagree", async () => {
		const sid = db.createService({ name: "quiet", provider: "duckdns", username: "t" });
		const did = db.addDomain(sid, { hostname: "q", domainname: "duckdns.org" });
		network({ "ipinfo.io": () => [200, { ip: "203.0.113.1" }], "api.ipify.org": () => [200, { ip: "203.0.113.2" }] });
		await expect(checkOnce()).rejects.toThrow("disagree");
		expect(db.countUpdates({ domainId: did })).toBe(0);
		expect(db.getState("last_check_error").value).toContain("disagree");
		db.deleteService(sid);
	});

	it("skips a push-on-change record whose IP is already set", async () => {
		const sid = db.createService({ name: "free", provider: "afraid", password: "dGVzdHRva2Vu" });
		const did = db.addDomain(sid, { hostname: "home", domainname: "mooo.com" });
		const calls = network({
			...ipSources("198.51.100.8"),
			"freedns.afraid.org": () => [200, "Updated 1 host(s) home.mooo.com to 198.51.100.8 in 0.1 seconds"],
		});
		await checkOnce();
		await checkOnce();
		expect(calls.filter((c) => c.url.hostname === "freedns.afraid.org")).toHaveLength(1);
		expect(db.recentUpdates(1, { domainId: did })[0]).toMatchObject({ ok: 2 });
		db.deleteService(sid);
	});
});

describe("notifications", () => {
	it("builds Discord and Gotify requests from env", () => {
		process.env.EZDYNDNS_DISCORD_WEBHOOK_URL = "https://discord.example/hook";
		process.env.EZDYNDNS_GOTIFY_URL = "https://gotify.example/";
		process.env.EZDYNDNS_GOTIFY_TOKEN = "app-token";
		try {
			const byName = Object.fromEntries(channels().map((c) => [c.name, c]));
			const n = { event: "recovered", title: "T", message: "M", priority: "high", tags: "" };
			const [dUrl, dInit] = byName.discord.request(n);
			expect(dUrl).toBe("https://discord.example/hook");
			expect(JSON.parse(dInit.body)).toEqual({ content: "**T**\nM" });
			const [gUrl, gInit] = byName.gotify.request(n);
			expect(gUrl).toBe("https://gotify.example/message");
			expect(gInit.headers["X-Gotify-Key"]).toBe("app-token");
			expect(JSON.parse(gInit.body).priority).toBe(8);
		} finally {
			delete process.env.EZDYNDNS_DISCORD_WEBHOOK_URL;
			delete process.env.EZDYNDNS_GOTIFY_URL;
			delete process.env.EZDYNDNS_GOTIFY_TOKEN;
		}
	});
});

describe("toolbox parsing", () => {
	it("accepts DNS names and rejects junk", () => {
		expect(cleanName("_dmarc.Example.COM.")).toBe("_dmarc.example.com");
		expect(cleanName("example")).toBeNull();
		expect(cleanName("bad name.com")).toBeNull();
		expect(toolQuery({ name: "8.8.8.8", type: "ptr" })).toEqual({ name: "8.8.8.8", type: "PTR" });
		expect(toolQuery({ name: "x.com", type: "ANY" }).error).toBeTruthy();
	});

	it("reads SPF and DMARC records", () => {
		expect(parseSpf("v=spf1 include:_spf.example.com mx -all")).toEqual({ terms: ["include:_spf.example.com", "mx", "-all"], all: "-all" });
		expect(parseTags("v=DMARC1; p=reject; rua=mailto:d@example.com")).toMatchObject({ p: "reject", rua: "mailto:d@example.com" });
	});

	it("judges a record from authoritative and public answers", () => {
		const r = (values) => ({ values });
		expect(verdictFor({ authoritative: [r(["1.1.1.1"])], public: [r(["1.1.1.1"])] }, "1.1.1.1")).toBe("resolves");
		expect(verdictFor({ authoritative: [r(["1.1.1.1"])], public: [r(["9.9.9.9"])] }, "1.1.1.1")).toBe("propagating");
		expect(verdictFor({ authoritative: [r(["9.9.9.9"])], public: [] }, "1.1.1.1")).toBe("mismatch");
		expect(verdictFor({ authoritative: [{ values: [], error: "timed out" }], public: [] }, "1.1.1.1")).toBe("unknown");
	});

	it("joins every string of a multi-string TXT record (Bun's resolveTxt drops all but the first)", () => {
		const query = encodeQuery("example.com", 16, 0x1234);
		const first = `v=spf1 ${"a".repeat(240)}`;
		const rdata = Buffer.concat([Buffer.from([first.length]), Buffer.from(first), Buffer.from([5]), Buffer.from(" -all")]);
		const answer = Buffer.concat([
			Buffer.from([0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 1, 44]), // name pointer, TXT, IN, TTL 300
			Buffer.from([rdata.length >> 8, rdata.length & 0xff]),
			rdata,
		]);
		const response = Buffer.concat([query.subarray(0, 12), query.subarray(12), answer]);
		response.writeUInt16BE(0x8180, 2); // response, no error
		response.writeUInt16BE(1, 6); // one answer
		expect(decodeTxt(response)).toEqual({ rcode: 0, records: [{ text: `${first} -all`, ttl: 300 }] });
	});

	it("quotes CSV cells that need it", () => {
		const csv = updatesCsv([
			{ created_at: "2026-10-31 10:00:00", hostname: "@", domainname: "example.com", service_name: "s", old_ip: "", new_ip: "1.1.1.1", ok: 0, detail: 'bad "token", retry' },
		]);
		expect(csv.split("\n")[1]).toBe('2026-10-31 10:00:00,example.com,s,,1.1.1.1,failed,"bad ""token"", retry"');
	});
});
