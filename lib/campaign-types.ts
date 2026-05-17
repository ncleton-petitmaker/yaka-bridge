export type CampaignStatus = "draft" | "active" | "archived";

export interface Campaign {
  id: string;
  label: string;
  status: CampaignStatus;
  createdAt: string;
  basedOn: string | null;
  dateOuverture?: string;
  dateCloture?: string;
}

export interface CampaignManifest {
  id: string;
  skillHashes: Record<string, string>;
  schemaHash: string | null;
  createdAt: string;
  basedOn: string | null;
  appVersion: string;
}

export interface CampaignsIndex {
  campaigns: Campaign[];
  activeId: string;
  layoutVersion: number;
  layoutV1Confirmed?: boolean;
}

export interface CampaignDetail {
  campaign: Campaign;
  manifest: CampaignManifest;
  stats: {
    evaluations: number;
    propositionsTotal: number;
    propositionsPromues: number;
  };
  skills: { filename: string; size: number; hash: string }[];
}
