"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/Icon";
import { apiFetch } from "@/lib/api-client";

type BridgeConnection = "checking" | "connected" | "disconnected";
type InstallerPlatform = "windows" | "mac";

interface BridgeInstaller {
  platform: InstallerPlatform;
  label: string;
  extension: "exe" | "dmg";
  installerUrl: string;
  installerFilename: string;
  installerChunks?: Array<{ index: number; url: string }>;
}

interface BridgeConfig {
  appName: string;
  bridgeUrl: string;
  healthPath: string;
  expectedPort: number;
  installerUrl: string;
  installerFilename: string;
  installerChunks?: Array<{ index: number; url: string }>;
  installers?: BridgeInstaller[];
  procedure: string[];
}

interface BridgeState {
  status: BridgeConnection;
  config: BridgeConfig | null;
  lastCheckedAt: string | null;
  error: string | null;
  openSetup: () => void;
  refresh: () => Promise<void>;
}

const BridgeContext = createContext<BridgeState | null>(null);
const POLL_MS = 15_000;
const ACTIVE_SESSION_TTL_MS = 15 * 60_000;
const STORAGE_KEY = "app-template:bridge-wizard-seen";
const ACTIVE_SESSION_STORAGE_KEY = "app-template:bridge-active-session";

export function BridgeStatusProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [status, setStatus] = useState<BridgeConnection>("checking");
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [toastDismissed, setToastDismissed] = useState(false);
  const firstLaunchHandledRef = useRef(false);
  const suppressBridgeSetupUi = pathname === "/bridge-mascot";

  const refresh = useCallback(async () => {
    setStatus((current) => (current === "connected" ? current : "checking"));
    try {
      const nextConfig = await loadBridgeConfig();
      setConfig(nextConfig);
      const probe = await probeBridge(nextConfig);
      const visibleConnected = probe.connected || shouldKeepBridgeActiveFromSession();
      if (probe.connected) markBridgeSessionActive();
      setStatus(visibleConnected ? "connected" : "disconnected");
      setError(visibleConnected ? null : probe.error);
    } catch (err) {
      const visibleConnected = shouldKeepBridgeActiveFromSession();
      setStatus(visibleConnected ? "connected" : "disconnected");
      setError(visibleConnected ? null : err instanceof Error ? err.message : String(err));
    } finally {
      setLastCheckedAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    if (suppressBridgeSetupUi) return;

    let active = true;
    async function tick() {
      if (!active) return;
      await refresh();
    }
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [refresh, suppressBridgeSetupUi]);

  useEffect(() => {
    if (!lastCheckedAt || firstLaunchHandledRef.current) return;
    firstLaunchHandledRef.current = true;
    if (suppressBridgeSetupUi) return;
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") return;
    } catch {
      // Le badge reste utilisable si localStorage est indisponible.
    }
    setSetupOpen(true);
  }, [lastCheckedAt, suppressBridgeSetupUi]);

  useEffect(() => {
    if (status === "connected") {
      markBridgeSessionActive();
      setToastDismissed(false);
    }
  }, [status]);

  const openSetup = useCallback(() => {
    setSetupOpen(true);
    setToastDismissed(true);
  }, []);

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // no-op
    }
  }, []);

  const value = useMemo(
    () => ({ status, config, lastCheckedAt, error, openSetup, refresh }),
    [config, error, lastCheckedAt, openSetup, refresh, status]
  );

  return (
    <BridgeContext.Provider value={value}>
      {children}
      {setupOpen && !suppressBridgeSetupUi && <BridgeSetupModal onClose={closeSetup} />}
      {status === "disconnected" && !setupOpen && !toastDismissed && !suppressBridgeSetupUi && (
        <button type="button" className="bridge-toast" onClick={openSetup}>
          <span className="dot" aria-hidden />
          Bridge déconnecté. Cliquer pour reconnecter.
        </button>
      )}
    </BridgeContext.Provider>
  );
}

export function useBridgeStatus(): BridgeState {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error("useBridgeStatus doit être utilisé dans <BridgeStatusProvider>.");
  return ctx;
}

function markBridgeSessionActive(): void {
  try {
    sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, String(Date.now()));
  } catch {
    // no-op
  }
}

function shouldKeepBridgeActiveFromSession(): boolean {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    const ts = raw ? Number(raw) : 0;
    return Number.isFinite(ts) && ts > 0 && Date.now() - ts <= ACTIVE_SESSION_TTL_MS;
  } catch {
    return false;
  }
}

export function BridgeIndicator() {
  const { status, error, openSetup } = useBridgeStatus();
  const tone = status === "connected" ? "ok" : status === "checking" ? "warn" : "error";
  const title =
    status === "connected"
      ? "Bridge connecté"
      : status === "checking"
        ? "Test du bridge en cours"
        : error ?? "Bridge déconnecté. Cliquer pour reconnecter.";

  return (
    <button
      type="button"
      className={`pill bridge-indicator ${tone}`}
      onClick={openSetup}
      title={title}
      aria-label={title}
    >
      <span className="dot" aria-hidden />
      {status === "checking" ? "Bridge..." : "Bridge"}
    </button>
  );
}

function BridgeSetupModal({ onClose }: { onClose: () => void }) {
  const { status, config, lastCheckedAt, error, refresh } = useBridgeStatus();
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<InstallerPlatform>(() => detectInstallerPlatform());
  const connected = status === "connected";
  const statusLabel = connected ? "Connecté" : status === "checking" ? "Vérification..." : "Déconnecté";
  const statusDetail = connected
    ? `Dernier test réussi${lastCheckedAt ? ` à ${new Date(lastCheckedAt).toLocaleTimeString("fr-FR")}` : ""}.`
    : error ?? "Télécharge Bridge si l'app a été supprimée, puis relance le test.";
  const installer = installerFromConfig(config, selectedPlatform);

  return (
    <div className="modal-backdrop bridge-modal-backdrop" role="presentation">
      <section className="modal bridge-modal" role="dialog" aria-modal="true" aria-labelledby="bridge-modal-title">
        <header className="modal-header">
          <div className={`bridge-status-led ${connected ? "ok" : status === "checking" ? "warn" : "error"}`}>
            <span className="dot" aria-hidden />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="bridge-modal-title">Bridge</h2>
            <p className="card-sub">
              {connected
                ? "Ce poste peut relier les services autorisés."
                : "Installe Bridge pour connecter ce poste aux services autorisés."}
            </p>
          </div>
          <button type="button" className="ghost icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="modal-body bridge-modal-body">
          <div className={`bridge-summary ${connected ? "ok" : status === "checking" ? "warn" : "error"}`}>
            <div className="bridge-summary-main">
              <span className="dot" aria-hidden />
              <div>
                <span className="bridge-summary-kicker">Statut du poste</span>
                <strong>{statusLabel}</strong>
                <p>{statusDetail}</p>
              </div>
            </div>
            <button type="button" className="ghost bridge-inline-action" onClick={() => void refresh()} disabled={status === "checking"}>
              <Icon name={status === "checking" ? "spinner" : "refresh"} size={14} />
              Tester
            </button>
          </div>

          <div className="bridge-install-list">
            <article className="bridge-install-row">
              <div className="bridge-step-index">1</div>
              <div>
                <h3>Télécharger Bridge</h3>
                <p>Format détecté : <strong>{installer.label}</strong>. Si Bridge a été désinstallé, ce téléchargement réinstalle aussi le lien système.</p>
                <div className="bridge-os-toggle" aria-label="Choisir le système">
                  {(["mac", "windows"] as const).map((platform) => (
                    <button
                      key={platform}
                      type="button"
                      className={selectedPlatform === platform ? "active" : ""}
                      onClick={() => setSelectedPlatform(platform)}
                    >
                      {platform === "mac" ? "macOS · DMG" : "Windows · EXE"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="primary bridge-primary-action"
                  onClick={() => void downloadInstaller(installer, setDownloadMessage, setDownloading)}
                  disabled={downloading}
                >
                  <Icon name={downloading ? "spinner" : "download"} size={14} />
                  {downloading
                    ? "Préparation..."
                    : installer.extension === "exe"
                      ? "Réinstaller Bridge"
                      : "Réinstaller Bridge"}
                </button>
                <span className="bridge-file-name">{installer.installerFilename}</span>
                {downloadMessage && <p className="bridge-message">{downloadMessage}</p>}
              </div>
            </article>

            <article className="bridge-install-row">
              <div className="bridge-step-index">2</div>
              <div>
                <h3>Ouvrir Bridge</h3>
                <p>
                  Après installation, ouvre Bridge pour réactiver le lien système et le service local.
                </p>
                <button type="button" className="subtle bridge-secondary-action" onClick={openBridgeProtocol}>
                  <Icon name="external-link" size={14} />
                  Ouvrir Bridge
                </button>
                <code className="bridge-url">{config?.bridgeUrl ?? "http://127.0.0.1:7707"}</code>
              </div>
            </article>

            <article className="bridge-install-row">
              <div className="bridge-step-index">3</div>
              <div>
                <h3>Valider la connexion</h3>
                <p>Quand le statut passe vert, le service web peut utiliser Bridge sur ce poste.</p>
                <button type="button" className="subtle bridge-secondary-action" onClick={() => void refresh()} disabled={status === "checking"}>
                  <Icon name={status === "checking" ? "spinner" : "refresh"} size={14} />
                  Tester la connexion
                </button>
              </div>
            </article>
          </div>

          <details className="bridge-details">
            <summary>Détails techniques</summary>
            <div>
              {(config?.procedure ?? []).map((step) => (
                <p key={step}>{step}</p>
              ))}
            </div>
          </details>
        </div>
      </section>
    </div>
  );
}

async function loadBridgeConfig(): Promise<BridgeConfig> {
  const res = await apiFetch("/api/bridge/status");
  if (!res.ok) throw new Error(`GET /api/bridge/status ${res.status}`);
  return (await res.json()) as BridgeConfig;
}

async function probeBridge(config: BridgeConfig): Promise<{ connected: boolean; error: string | null }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${config.bridgeUrl}${config.healthPath}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return { connected: false, error: `Healthcheck bridge HTTP ${res.status}` };
    const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return payload?.ok ? { connected: true, error: null } : { connected: false, error: "Healthcheck bridge invalide" };
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Le bridge ne répond pas."
      : "Bridge local introuvable ou bloqué par CORS.";
    return { connected: false, error: message };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function downloadInstaller(
  installer: BridgeInstaller,
  setMessage: (message: string | null) => void,
  setDownloading: (downloading: boolean) => void
): Promise<void> {
  setDownloading(true);
  setMessage(null);
  try {
    if (installer.installerChunks?.length) {
      const chunks = [...installer.installerChunks].sort((a, b) => a.index - b.index);
      const parts: ArrayBuffer[] = [];
      for (const chunk of chunks) {
        setMessage(`Téléchargement du morceau ${chunk.index + 1}/${chunks.length}...`);
        const res = await fetch(chunk.url);
        if (!res.ok) throw new Error(`Chunk ${chunk.index + 1} indisponible (${res.status})`);
        parts.push(await res.arrayBuffer());
      }
      saveBlob(new Blob(parts, { type: "application/octet-stream" }), installer.installerFilename);
      setMessage("Téléchargement lancé.");
      return;
    }
    downloadDirect(installer.installerUrl, installer.installerFilename);
    setMessage("Téléchargement lancé.");
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err));
  } finally {
    setDownloading(false);
  }
}

function openBridgeProtocol(): void {
  window.location.href = "bridge://status";
}

function installerFromConfig(config: BridgeConfig | null, platform: InstallerPlatform): BridgeInstaller {
  const match = config?.installers?.find((candidate) => candidate.platform === platform);
  if (match) return match;
  if (platform === "mac") {
    return {
      platform: "mac",
      label: "macOS",
      extension: "dmg",
        installerUrl: "/bridge/Bridge.dmg",
        installerFilename: "Bridge.dmg",
    };
  }
  return {
    platform: "windows",
    label: "Windows",
    extension: "exe",
    installerUrl: config?.installerUrl ?? "/bridge/Bridge-Setup.exe",
    installerFilename: config?.installerFilename ?? "Bridge-Setup.exe",
    installerChunks: config?.installerChunks,
  };
}

function detectInstallerPlatform(): InstallerPlatform {
  if (typeof navigator === "undefined") return "windows";
  const userAgent = navigator.userAgent || "";
  const hintedPlatform =
    "userAgentData" in navigator
      ? (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || ""
      : "";
  const platform = navigator.platform || "";
  const signature = `${userAgent} ${hintedPlatform} ${platform}`;

  if (/windows|win32|win64|wow64/i.test(signature)) return "windows";
  return /mac|darwin|iphone|ipad/i.test(signature) ? "mac" : "windows";
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadDirect(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadDirect(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
