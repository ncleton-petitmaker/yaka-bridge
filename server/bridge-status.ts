export interface BridgeStatusPayload {
  ok: true;
  appName: string;
  runtime: "local-daemon" | "server";
  bridgeUrl: string;
  healthPath: string;
  expectedPort: number;
  installerUrl: string;
  installerFilename: string;
  installerChunks?: Array<{ index: number; url: string }>;
  installers: BridgeInstaller[];
  procedure: string[];
  checkedAt: string;
}

export interface BridgeInstaller {
  platform: "windows" | "mac";
  label: string;
  extension: "exe" | "dmg";
  installerUrl: string;
  installerFilename: string;
  installerChunks?: Array<{ index: number; url: string }>;
}

const DEFAULT_PORT = Number(process.env["NEXT_PUBLIC_BRIDGE_PORT"] ?? "7707") || 7707;
const DEFAULT_BRIDGE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
const DEFAULT_INSTALLER_BASE_URL = "/bridge";
const WINDOWS_INSTALLER_FILENAME = "Bridge-Setup.exe";
const MAC_INSTALLER_FILENAME = "Bridge.dmg";

export function getBridgeStatusPayload(runtime: BridgeStatusPayload["runtime"]): BridgeStatusPayload {
  const bridgeUrl = cleanUrl(process.env["NEXT_PUBLIC_BRIDGE_URL"]) ?? DEFAULT_BRIDGE_URL;
  const installerBaseUrl =
    cleanPathOrUrl(process.env["NEXT_PUBLIC_BRIDGE_INSTALLER_BASE_URL"]) ?? DEFAULT_INSTALLER_BASE_URL;
  const windowsInstallerUrl = joinUrl(installerBaseUrl, WINDOWS_INSTALLER_FILENAME);
  const macInstallerUrl = joinUrl(installerBaseUrl, MAC_INSTALLER_FILENAME);
  const installerUrl =
    cleanPathOrUrl(process.env["NEXT_PUBLIC_BRIDGE_INSTALLER_URL"]) ?? windowsInstallerUrl;
  const expectedPort = Number(new URL(bridgeUrl).port || DEFAULT_PORT) || DEFAULT_PORT;
  const installerFilename = installerUrl.split("/").filter(Boolean).pop() ?? WINDOWS_INSTALLER_FILENAME;
  const installers: BridgeInstaller[] = [
    {
      platform: "windows",
      label: "Windows",
      extension: "exe",
      installerUrl: windowsInstallerUrl,
      installerFilename: WINDOWS_INSTALLER_FILENAME,
    },
    {
      platform: "mac",
      label: "macOS",
      extension: "dmg",
      installerUrl: macInstallerUrl,
      installerFilename: MAC_INSTALLER_FILENAME,
    },
  ];

  return {
    ok: true,
    appName: "Bridge",
    runtime,
    bridgeUrl,
    healthPath: "/api/health",
    expectedPort,
    installerUrl,
    installerFilename,
    installers,
    procedure: [
      "Télécharger puis lancer Bridge sur ce poste.",
      `Vérifier que le bridge écoute sur ${bridgeUrl}.`,
      "Revenir dans le service web et cliquer sur Tester la connexion.",
      "Laisser Bridge ouvert pendant les actions agentiques et les connexions multi-services.",
    ],
    checkedAt: new Date().toISOString(),
  };
}

function cleanUrl(value: string | undefined): string | null {
  const clean = value?.trim().replace(/\/+$/, "");
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function cleanPathOrUrl(value: string | undefined): string | null {
  const clean = value?.trim();
  if (!clean) return null;
  if (clean.startsWith("/")) return clean;
  return cleanUrl(clean);
}

function joinUrl(base: string, filename: string): string {
  return `${base.replace(/\/+$/, "")}/${filename}`;
}
