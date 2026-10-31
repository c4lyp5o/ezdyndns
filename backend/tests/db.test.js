import { describe, expect, it } from "bun:test";
// tests/setup.js (bunfig preload) points EZDYNDNS_DB at a throwaway file.
const db = await import("../db");
const { decryptSecret } = await import("../crypto");
const { validateServiceEdit } = await import("../routes/api");

describe("updateService", () => {
	it("writes only the fields given and keeps blank credentials", () => {
		const id = db.createService({ name: "svc", provider: "dedyn", username: "tok-1", interval_sec: 300 });
		db.updateService(id, { name: "svc-2", username: "", interval_sec: "600" });
		const s = db.getService(id);
		expect(s.name).toBe("svc-2");
		expect(s.interval_sec).toBe(600);
		expect(decryptSecret(s.username)).toBe("tok-1");
		db.updateService(id, { username: "tok-2" });
		expect(decryptSecret(db.getService(id).username)).toBe("tok-2");
	});
});

describe("domainHealth and log filters", () => {
	it("counts the failure streak and filters the log", () => {
		const id = db.createService({ name: "health", provider: "namecheap", password: "k" });
		const domainId = db.addDomain(id, { hostname: "home", domainname: "example.net" });
		db.logUpdate(id, domainId, { new_ip: "203.0.113.1", ok: true });
		db.logUpdate(id, domainId, { new_ip: "203.0.113.1", ok: false, detail: "x" });
		db.logUpdate(id, domainId, { new_ip: "203.0.113.1", ok: false, detail: "y" });
		const d = db.domainHealth().find((r) => r.id === Number(domainId));
		expect(d.fail_streak).toBe(2);
		expect(d.last.detail).toBe("y");
		expect(d.last_ok.new_ip).toBe("203.0.113.1");
		expect(db.recentUpdates(10, { domainId, failedOnly: true })).toHaveLength(2);
		expect(db.countUpdates({ domainId })).toBe(3);
	});
});

describe("validateServiceEdit", () => {
	it("rejects bad values and accepts blanks", () => {
		expect(validateServiceEdit({ interval_sec: "30" })).toContain("60");
		expect(validateServiceEdit({ status: "gone" })).toContain("active");
		expect(validateServiceEdit({ name: "  " })).toContain("empty");
		expect(validateServiceEdit({ name: "ok", interval_sec: "", status: "" })).toBeNull();
	});
});
