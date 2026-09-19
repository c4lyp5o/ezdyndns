const config = {
	port: Number(process.env.PORT) || 5070,
	apiToken: process.env.EZDYNDNS_TOKEN,
	encryptionKey: process.env.EZDYNDNS_ENCRYPTION_KEY,
};

if (!config.encryptionKey) {
	throw new Error("EZDYNDNS_ENCRYPTION_KEY is required; provider credentials are encrypted at rest");
}

if (!config.apiToken) {
	throw new Error("EZDYNDNS_TOKEN is required; the management API is never unauthenticated");
}

export default config;