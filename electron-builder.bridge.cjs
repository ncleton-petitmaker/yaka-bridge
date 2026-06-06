module.exports = {
  appId: "app.bridge.desktop",
  productName: "Bridge",
  directories: {
    output: "release-bridge",
  },
  asar: false,
  files: [
    "dist/bridge/**/*",
    "data-template/**/*",
    "public/**/*",
    "!public/bridge/**",
    "package.json",
    "node_modules/@anthropic-ai/**/*",
    "node_modules/openai/**/*",
    "node_modules/@supabase/**/*",
    "node_modules/zod/**/*",
    "node_modules/yaml/**/*",
  ],
  extraMetadata: {
    main: "dist/bridge/electron-main.cjs",
  },
  mac: {
    category: "public.app-category.productivity",
    icon: "public/icon.icns",
    target: ["dmg"],
  },
  win: {
    icon: "public/icon-512.png",
    target: ["nsis"],
    artifactName: "Bridge-Setup-${version}.exe",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
  },
};
