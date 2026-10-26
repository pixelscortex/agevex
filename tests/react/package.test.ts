/** React consumers share Agent's optional React 18/19 compatibility contract. */
import { expect, it } from "vite-plus/test";
import agent from "@convex-dev/agent/package.json";
import pkg from "../../package.json";

it("React 18.3.1 and React 19 consumers have the same optional peer range as native Agent", () => {
  expect(pkg.peerDependencies.react).toBe("^18.3.1 || ^19.0.0");
  expect(pkg.peerDependencies.react).toBe(agent.peerDependencies.react);
  expect(pkg.peerDependenciesMeta.react.optional).toBe(true);
});
