import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  agentRules: false,
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
};

export default withMDX(config);
