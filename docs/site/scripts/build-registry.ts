import { siteConfig } from '../site.config';

// registry.json and public/r are generated identity consumers. Changing the
// single name in site.config.ts and running the build updates both.
const file = Bun.file(new URL('../registry.json', import.meta.url));
const registry = await file.json();
registry.name = siteConfig.registryNamespace;
registry.homepage = siteConfig.localUrl;
await Bun.write(file, `${JSON.stringify(registry, null, 2)}\n`);

const result = Bun.spawnSync(['bunx', 'shadcn', 'build'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (result.exitCode !== 0) process.exit(result.exitCode);

// Serve the registry index alongside the generated item.
await Bun.write(new URL('../public/r/registry.json', import.meta.url), file);
