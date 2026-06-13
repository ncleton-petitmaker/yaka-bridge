import { spawnSync } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import { DEFAULT_LOCAL_MODEL } from "./app-config.js";

export interface LocalModelRecommendation {
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryGb: number;
  cpuCount: number;
  accelerator: "apple-silicon" | "nvidia" | "cpu";
  gpuMemoryGb?: number;
  tier: "cloud-first" | "small-local" | "standard-local" | "large-local";
  recommendedModel: string;
  minimumMemoryGb: number;
  downloadSizeGb: number;
  reason: string;
}

export interface LocalHardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryGb: number;
  cpuCount: number;
  gpuMemoryGb?: number;
}

const GRANITE_4_MICRO = {
  id: DEFAULT_LOCAL_MODEL,
  minimumMemoryGb: 8,
  downloadSizeGb: 2.25,
};

const GPT_OSS_20B = {
  id: "openai/gpt-oss-20b",
  minimumMemoryGb: 16,
  downloadSizeGb: 12,
};

const GPT_OSS_120B = {
  id: "openai/gpt-oss-120b",
  minimumMemoryGb: 65,
  downloadSizeGb: 65,
};

export function recommendLocalModel(profile = readLocalHardwareProfile()): LocalModelRecommendation {
  const accelerator = detectAccelerator(profile);

  if (profile.totalMemoryGb < 16) {
    return {
      platform: profile.platform,
      arch: profile.arch,
      totalMemoryGb: profile.totalMemoryGb,
      cpuCount: profile.cpuCount,
      accelerator,
      ...(profile.gpuMemoryGb ? { gpuMemoryGb: profile.gpuMemoryGb } : {}),
      tier: "cloud-first",
      recommendedModel: GRANITE_4_MICRO.id,
      minimumMemoryGb: GRANITE_4_MICRO.minimumMemoryGb,
      downloadSizeGb: GRANITE_4_MICRO.downloadSizeGb,
      reason: "Machine modeste: ChatGPT Codex reste conseillé par défaut, mais Granite 4 Micro est le modèle local de secours le plus portable.",
    };
  }

  if (shouldUseLargeModel(profile)) {
    return {
      platform: profile.platform,
      arch: profile.arch,
      totalMemoryGb: profile.totalMemoryGb,
      cpuCount: profile.cpuCount,
      accelerator,
      ...(profile.gpuMemoryGb ? { gpuMemoryGb: profile.gpuMemoryGb } : {}),
      tier: "large-local",
      recommendedModel: GPT_OSS_120B.id,
      minimumMemoryGb: GPT_OSS_120B.minimumMemoryGb,
      downloadSizeGb: GPT_OSS_120B.downloadSizeGb,
      reason:
        accelerator === "nvidia"
          ? "GPU NVIDIA haut de gamme détecté: le modèle 120B peut être proposé à l'admin pour les postes premium."
          : "Mémoire unifiée élevée détectée: le modèle 120B peut être proposé à l'admin pour les postes premium.",
    };
  }

  if (profile.totalMemoryGb < 32) {
    return {
      platform: profile.platform,
      arch: profile.arch,
      totalMemoryGb: profile.totalMemoryGb,
      cpuCount: profile.cpuCount,
      accelerator,
      ...(profile.gpuMemoryGb ? { gpuMemoryGb: profile.gpuMemoryGb } : {}),
      tier: "small-local",
      recommendedModel: GRANITE_4_MICRO.id,
      minimumMemoryGb: GRANITE_4_MICRO.minimumMemoryGb,
      downloadSizeGb: GRANITE_4_MICRO.downloadSizeGb,
      reason:
        accelerator === "apple-silicon"
          ? "Apple Silicon standard: Granite 4 Micro garde l'installation locale légère et compatible."
          : "Mémoire suffisante: Granite 4 Micro est le choix local compatible pour les actions explicitement routées.",
    };
  }

  if (profile.totalMemoryGb < 64 || accelerator === "cpu") {
    return {
      platform: profile.platform,
      arch: profile.arch,
      totalMemoryGb: profile.totalMemoryGb,
      cpuCount: profile.cpuCount,
      accelerator,
      ...(profile.gpuMemoryGb ? { gpuMemoryGb: profile.gpuMemoryGb } : {}),
      tier: "standard-local",
      recommendedModel: GRANITE_4_MICRO.id,
      minimumMemoryGb: GRANITE_4_MICRO.minimumMemoryGb,
      downloadSizeGb: GRANITE_4_MICRO.downloadSizeGb,
      reason:
        accelerator === "cpu"
          ? "Machine confortable mais sans accélérateur explicite: Granite 4 Micro reste le choix local le plus robuste."
          : "Machine confortable: Granite 4 Micro reste le défaut local portable avant benchmark client.",
    };
  }

  return {
    platform: profile.platform,
    arch: profile.arch,
    totalMemoryGb: profile.totalMemoryGb,
    cpuCount: profile.cpuCount,
    accelerator,
    ...(profile.gpuMemoryGb ? { gpuMemoryGb: profile.gpuMemoryGb } : {}),
    tier: "standard-local",
    recommendedModel: GPT_OSS_20B.id,
    minimumMemoryGb: GPT_OSS_20B.minimumMemoryGb,
    downloadSizeGb: GPT_OSS_20B.downloadSizeGb,
    reason:
      accelerator === "nvidia"
        ? "GPU NVIDIA confortable détecté: gpt-oss-20b peut être proposé pour de meilleurs runs locaux."
        : "Mémoire unifiée confortable détectée: gpt-oss-20b peut être proposé pour de meilleurs runs locaux.",
  };
}

export function readLocalHardwareProfile(): LocalHardwareProfile {
  const currentPlatform = platform();
  const currentArch = arch();
  return {
    platform: currentPlatform,
    arch: currentArch,
    totalMemoryGb: roundGb(totalmem() / 1024 ** 3),
    cpuCount: cpus().length,
    ...detectNvidiaGpuMemory(),
  };
}

function detectAccelerator(profile: LocalHardwareProfile): LocalModelRecommendation["accelerator"] {
  if (profile.platform === "darwin" && profile.arch === "arm64") return "apple-silicon";
  if ((profile.gpuMemoryGb ?? 0) > 0) return "nvidia";
  return "cpu";
}

function shouldUseLargeModel(profile: LocalHardwareProfile): boolean {
  if (profile.totalMemoryGb < 96) return false;
  if (profile.platform === "darwin" && profile.arch === "arm64") return true;
  return (profile.gpuMemoryGb ?? 0) >= 64;
}

function detectNvidiaGpuMemory(): Pick<LocalHardwareProfile, "gpuMemoryGb"> {
  const probe = spawnSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    timeout: 1200,
    windowsHide: true,
  });
  if (probe.status !== 0 || !probe.stdout.trim()) return {};
  const memoryMb = probe.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!memoryMb.length) return {};
  return { gpuMemoryGb: roundGb(Math.max(...memoryMb) / 1024) };
}

function roundGb(value: number): number {
  return Math.round(value * 10) / 10;
}
