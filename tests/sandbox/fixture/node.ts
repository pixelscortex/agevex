"use node";

import { sandboxNodeExport } from "../../../src/modules/sandbox/client/index.js";
import { config } from "./host.js";

export const exportFile = sandboxNodeExport(config());
