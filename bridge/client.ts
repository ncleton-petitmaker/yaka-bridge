import type {
  BridgeBusEvent,
  BridgeConfig,
  BridgeControlPlaneEnvelope,
  BridgeControlPlaneSyncResponse,
  BridgeJobCompletePayload,
  BridgeLaunchTicketRequest,
  BridgeLaunchTicketResponse,
  BridgeRunEventBatch,
  CloudBridgeJob,
} from "./types.js";

export class BridgeCloudClient {
  constructor(private readonly cfg: BridgeConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.controlPlaneBaseUrl && this.cfg.bridgeToken);
  }

  async register(capabilities: Record<string, unknown>): Promise<{
    ok: boolean;
    bridgeId?: string;
    serverTime?: string;
  }> {
    return this.post("bridge/register", {
      installId: this.cfg.installId,
      deviceId: this.cfg.deviceId,
      label: this.cfg.label,
      capabilities,
    });
  }

  async sync(state: unknown): Promise<BridgeControlPlaneSyncResponse> {
    return this.post("bridge/sync", {
      installId: this.cfg.installId,
      deviceId: this.cfg.deviceId,
      label: this.cfg.label,
      state,
    });
  }

  async services(): Promise<BridgeControlPlaneSyncResponse> {
    return this.post("bridge/services", {
      installId: this.cfg.installId,
      deviceId: this.cfg.deviceId,
    });
  }

  async poll(capabilities: Record<string, unknown>): Promise<{
    ok: boolean;
    jobs: CloudBridgeJob[];
  }> {
    return this.post("bridge/jobs/poll", {
      installId: this.cfg.installId,
      deviceId: this.cfg.deviceId,
      bridgeId: this.cfg.bridgeId,
      label: this.cfg.label,
      capabilities,
      serviceIds: this.cfg.services.filter((service) => !service.paused).map((service) => service.serviceId),
    });
  }

  async sendRunEventBatch(batch: BridgeRunEventBatch): Promise<void> {
    const res = await this.post<{ ok: boolean; error?: string }>("bridge/jobs/events", batch);
    if (!res.ok) throw new Error(res.error ?? "bridge/jobs/events échoué");
  }

  async completeJob(payload: BridgeJobCompletePayload): Promise<void> {
    const res = await this.post<{ ok: boolean; error?: string }>("bridge/jobs/complete", payload);
    if (!res.ok) throw new Error(res.error ?? "bridge/jobs/complete échoué");
  }

  async createLaunchTicket(request: BridgeLaunchTicketRequest): Promise<BridgeLaunchTicketResponse> {
    return this.post("bridge/launch-ticket", request);
  }

  async publishBusEvent(event: BridgeBusEvent): Promise<{ ok: boolean; error?: string }> {
    return this.post("bridge/bus/events", event);
  }

  async callServiceAction(input: {
    sourceServiceId: string;
    targetServiceId: string;
    actionId: string;
    payload: Record<string, unknown>;
  }): Promise<{ ok: boolean; output?: unknown; error?: string }> {
    return this.post("bridge/bus/actions/call", input);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    if (!this.cfg.controlPlaneBaseUrl) {
      throw new Error("Control Plane Bridge non configuré.");
    }
    return this.rawPost<T>(path, payload);
  }

  private async rawPost<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridge-protocol-version": "2",
        "x-bridge-organization-id": this.cfg.organizationId ?? "",
        "x-bridge-id": this.cfg.bridgeId ?? "",
        "x-bridge-install-id": this.cfg.installId ?? "",
        "x-bridge-device-id": this.cfg.deviceId ?? "",
        "x-bridge-user-id": this.cfg.userId ?? this.cfg.account?.userId ?? "",
        "x-bridge-token": this.cfg.bridgeToken ?? "",
      },
      body: JSON.stringify(this.envelope(payload)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 800)}`);
    }
    return (await res.json()) as T;
  }

  private envelope(payload: unknown): BridgeControlPlaneEnvelope {
    return {
      organizationId: this.cfg.organizationId,
      bridgeId: this.cfg.bridgeId,
      installId: this.cfg.installId,
      deviceId: this.cfg.deviceId,
      userId: this.cfg.userId ?? this.cfg.account?.userId,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  private url(path: string): string {
    return `${this.cfg.controlPlaneBaseUrl?.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }
}
