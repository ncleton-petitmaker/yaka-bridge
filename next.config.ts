import type { NextConfig } from "next";

// Le port du daemon est passé par l'env var injectée au scaffolding
// (placeholder remplacé par init-from-template.mjs).
const DAEMON_PORT =
  process.env["{{APP_NAME_KEBAB_UPPER}}_DAEMON_PORT"] ?? "{{DAEMON_PORT}}";

const config: NextConfig = {
  reactStrictMode: true,
  // Output standalone : produit .next/standalone/server.js auto-suffisant.
  // Permet de spawner Next en prod via Electron-as-Node sans dépendre du
  // CLI `next` (qui peut galérer sous ELECTRON_RUN_AS_NODE en mode packagé).
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${DAEMON_PORT}/api/:path*`,
      },
    ];
  },
};

export default config;
