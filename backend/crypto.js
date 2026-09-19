import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const rawKey = process.env.EZDYNDNS_ENCRYPTION_KEY
	? Buffer.from(process.env.EZDYNDNS_ENCRYPTION_KEY, "base64")
	: null;

if (rawKey && rawKey.length !== 32) {
	throw new Error("EZDYNDNS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
}

function requireKey() {
	if (!rawKey) {
		throw new Error("EZDYNDNS_ENCRYPTION_KEY is required to store provider credentials");
	}
	return rawKey;
}

export function encryptSecret(value) {
	if (!value) return null;
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", requireKey(), iv);
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value) {
	if (!value) return null;
	const [version, ivText, tagText, ciphertext] = value.split(":");
	if (version !== "v1" || !ivText || !tagText || !ciphertext) {
		throw new Error("stored provider credential has an unsupported format");
	}
	const decipher = createDecipheriv("aes-256-gcm", requireKey(), Buffer.from(ivText, "base64"));
	decipher.setAuthTag(Buffer.from(tagText, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
}