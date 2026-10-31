// What each provider calls its credentials, where ezdyndns stores them, and the
// copy the dashboard shows. The add/edit forms, the API's provider list and
// credential re-verification all read this, so a new provider is one entry here
// plus an adapter in providers.js.
//
// fields: the service columns a provider uses. `username` and `password` are
//   both encrypted at rest; the names are storage slots, not meanings.
// perRecord: a credential that can differ per record (stored on the domain).
// domain: the only zone the provider serves (Duck DNS).
// pushOnChange: push only when the IP differs from the last good push (plus a
//   daily re-assert) instead of every cycle, for services that frown on
//   repeated same-IP updates.
export const CATALOG = {
	namecheap: {
		label: "Namecheap",
		fields: [{ name: "password", label: "Dynamic DNS password", edit: "New Dynamic DNS password" }],
		perRecord: { label: "Per-domain password", required: false },
		hint: "Namecheap: Advanced DNS → Dynamic DNS. The password is checked on the first push.",
		editHint:
			"From Advanced DNS → Dynamic DNS. Namecheap can only check it on the next push, so watch the record's state after saving.",
	},
	cloudflare: {
		label: "Cloudflare",
		fields: [{ name: "username", label: "API token", edit: "New API token" }],
		hint: "Cloudflare: an API token with Zone · DNS · Edit. Verified before the service is saved.",
		editHint: "Needs Zone · DNS · Edit. A new token is verified with Cloudflare before it is saved.",
	},
	dedyn: {
		label: "deSEC",
		fields: [{ name: "username", label: "Token", edit: "New token" }],
		hint: "deSEC: a dedicated token scoped to domain/update/ttl/ip4, TTL at or under the check interval. Verifying it sends one real update.",
		editHint:
			"Scope it to domain/update/ttl/ip4 with a TTL at or under the check interval. A new token is verified with one real update before it is saved.",
	},
	duckdns: {
		label: "Duck DNS",
		fields: [{ name: "username", label: "Token", edit: "New token" }],
		domain: "duckdns.org",
		hint: "Duck DNS: the token from the top of duckdns.org. Host is your subname, domain is duckdns.org. Verifying it sends one real update.",
		editHint: "The token from the top of duckdns.org. A new token is verified with one real update before it is saved.",
	},
	porkbun: {
		label: "Porkbun",
		fields: [
			{ name: "username", label: "API key", edit: "New API key" },
			{ name: "password", label: "Secret API key", edit: "New secret API key" },
		],
		hint: "Porkbun: Account → API Access. Turn on API access for the domain too. Both keys are verified before the service is saved.",
		editHint: "Replace both keys together. They are verified with Porkbun before they are saved.",
	},
	digitalocean: {
		label: "DigitalOcean",
		fields: [{ name: "username", label: "API token", edit: "New API token" }],
		hint: "DigitalOcean: a personal access token with domain read and update scopes. Verified before the service is saved.",
		editHint: "Needs domain read and update scopes. A new token is verified before it is saved.",
	},
	gandi: {
		label: "Gandi",
		fields: [{ name: "username", label: "Personal access token", edit: "New personal access token" }],
		hint: "Gandi: a personal access token with Manage domain name technical configurations. Verified before the service is saved.",
		editHint: "Needs Manage domain name technical configurations. A new token is verified before it is saved.",
	},
	afraid: {
		label: "FreeDNS (afraid.org)",
		fields: [{ name: "password", label: "Update token", edit: "New update token" }],
		perRecord: { label: "This record's update token", required: true },
		pushOnChange: true,
		hint: "FreeDNS: Dynamic DNS → the record's update URL; paste the URL or the token after update.php?. Each record has its own token. Verifying it sends one real update.",
		editHint:
			"Each record has its own token; this one is used by records added without one. A new token is verified with one real update before it is saved.",
	},
};

export const PROVIDERS = Object.keys(CATALOG);

// What the browser needs to drive the add-service form; no server-only flags.
export const formCatalog = () =>
	Object.fromEntries(
		Object.entries(CATALOG).map(([id, p]) => [
			id,
			{ fields: p.fields.map(({ name, label }) => ({ name, label })), hint: p.hint, domain: p.domain ?? null },
		]),
	);
