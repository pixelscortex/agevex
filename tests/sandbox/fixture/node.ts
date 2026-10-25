"use node";

import { sandboxNodeExport } from "../../../src/sandbox/index.js";
import { config } from "./host.js";

export const exportFile = sandboxNodeExport(config());
