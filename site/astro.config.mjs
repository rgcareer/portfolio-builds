import { defineConfig } from 'astro/config';

// Static SSG output served by a Cloudflare Worker's [assets] block — no adapter, mirroring
// the portfolio-site setup. The canonical URL is the working workers.dev subdomain; the
// final named domain is set at launch.
export default defineConfig({
  site: 'https://skillcheck.smartbusinessaillc.workers.dev',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
