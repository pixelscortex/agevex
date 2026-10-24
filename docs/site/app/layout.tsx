import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { siteConfig } from '@/site.config';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.localUrl),
  title: { default: siteConfig.name, template: `%s | ${siteConfig.name}` },
  description: siteConfig.description,
  robots: { index: false, follow: false },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
