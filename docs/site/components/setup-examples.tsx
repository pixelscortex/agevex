import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { siteConfig } from '@/site.config';

function Code({ children, title }: { children: string; title: string }) {
  return (
    <CodeBlock title={title}>
      <Pre><code>{children}</code></Pre>
    </CodeBlock>
  );
}

export function SiteName() {
  return <>{siteConfig.name}</>;
}

export function InstallCommand() {
  return <Code title="Terminal">{`bun add git+${siteConfig.repository}.git#<commit-sha>\nbun add convex @convex-dev/agent ai`}</Code>;
}

export function MountExample() {
  return <Code title="convex/convex.config.ts">{`import { defineApp } from "convex/server";
import nativeAgent from "@convex-dev/agent/convex.config";
import sdk from "${siteConfig.name}/convex.config";

const app = defineApp();
app.use(nativeAgent, { name: "agent" });
app.use(sdk);
export default app;`}</Code>;
}

export function RegistryInstallCommand() {
  return <Code title="Terminal">{'bunx shadcn add <site-url>/r/todo-tool.json'}</Code>;
}
