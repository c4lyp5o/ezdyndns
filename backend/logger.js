import path from "node:path";
import { dataDir } from "./datadir.js";
import { createLogger } from "./ezlog.js";

const generalLogger = createLogger(
	path.join(dataDir(path.join(import.meta.dir, "..")), "logs"),
	"ezdyndns",
);

export default generalLogger;
