import type { NextConfig } from "next";

const DAEMON_PORT = process.env.FAE_DAEMON_PORT ?? "7456";

const config: NextConfig = {
  reactStrictMode: true,
  // Output standalone : produit .next/standalone/server.js auto-suffisant.
  // Permet de spawner Next en prod via Electron-as-Node sans dépendre du
  // CLI 'next' (qui peut galérer sous ELECTRON_RUN_AS_NODE en mode packagé).
  output: "standalone",
  // En build prod on tolère quelques erreurs TS pré-existantes (DiffViewer
  // import diffLines, types calibrage-imports, etc.). À nettoyer plus tard.
  typescript: { ignoreBuildErrors: true },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${DAEMON_PORT}/api/:path*`,
      },
      {
        source: "/pdfjs/:path*",
        destination: `http://localhost:${DAEMON_PORT}/pdfjs/:path*`,
      },
    ];
  },
};

export default config;
