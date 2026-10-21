import { defineApp } from "convex/server";
import nativeAgent from "@convex-dev/agent/convex.config.js";
import agevex from "agevex/convex.config";

const app = defineApp();

app.use(nativeAgent, { name: "agent" });
app.use(agevex);

export default app;
