// Preserve the existing agevex/test API while adding the optional fake. Core
// itself never imports a sandbox module; only hosts choosing this fake do so.
export * from "../test.js";
export { default } from "../test.js";
export { fakeSandboxProvider } from "./sandbox.js";
