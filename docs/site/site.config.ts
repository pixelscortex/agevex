// Provisional identity: change this name, then rebuild the site and registry.
const name = 'agevex';

export const siteConfig = {
  name,
  registryNamespace: `@${name}`,
  description: 'A Convex-native, headless Agent SDK for TypeScript.',
  repository: `https://github.com/pixelscortex/${name}`,
  localUrl: 'http://localhost:3000',
} as const;
