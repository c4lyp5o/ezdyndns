// Test preload (bunfig.toml): runs before any test file is imported. db.js opens
// its database at import time and Bun shares modules across test files, so a
// per-file EZDYNDNS_DB is too late once any earlier file imported db.js. Without
// this, `bun test` read and wrote the real db/ezdyndns.db — which a running
// container may be scheduling from.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EZDYNDNS_DB = join(tmpdir(), `ezdyndns-test-${process.pid}-${Date.now()}.db`);
process.env.EZDYNDNS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.EZDYNDNS_TOKEN = "test-token";
process.env.EZDYNDNS_NTFY_URL = "";
process.env.EZDYNDNS_RESOLVE_CHECKS = "0";
