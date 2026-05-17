/**
 * Types partagés entre serveur et UI. Mirroir compact de server/types.ts.
 */
export type AgentEventKind =
  | "status"
  | "text_delta"
  | "thinking_delta"
  | "tool_use_start"
  | "tool_use_input"
  | "tool_use_end"
  | "tool_result"
  | "message_start"
  | "message_stop"
  | "result"
  | "usage"
  | "error"
  | "stderr"
  | "rate_limit"
  | "raw";

export interface UsageInfo {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
  message_id?: string;
}

export interface AgentEvent {
  kind: AgentEventKind;
  text?: string;
  status?: string;
  tool?: { id: string; name: string; input?: unknown; output?: unknown };
  result?: { success: boolean; output?: string; durationMs?: number; costUsd?: number };
  usage?: UsageInfo;
  error?: string;
  raw?: unknown;
  ts: number;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DossierStatus = "a_faire" | "en_review" | "eligibilite_ok" | "valide" | "ineligible";

export interface DossierEntry {
  id: string;
  path: string;
  files: string[];
  status: DossierStatus;
  evaluationPath?: string;
  /** true si un run Claude est actuellement en cours sur ce dossier. */
  running?: boolean;
}

export interface ChatRequest {
  message: string;
  slashCommand?: string;
  user?: string;
  model?: string;
  workdir?: string;
}

export interface ChatRunCreated {
  runId: string;
}

// ===== Schéma d'évaluation FAE 7e (sortie attendue) =====

export type EligibiliteStatut = "OUI" | "NON" | "NON_TROUVE" | "AMBIGU" | "SANS_OBJET";
export type NotationStatut =
  | "EVALUE" | "NON_TROUVE" | "AMBIGU" | "VERIFICATION_EXTERNE" | "HORS_IA";

export interface StructuredSource {
  file: string;
  page?: number;
  sheet?: string;
  cell?: string;
  section?: string;
  quote?: string;
}
export type EvalSource = string | StructuredSource;

export interface CritereEligibilite {
  id: string;
  intitule: string;
  statut: EligibiliteStatut;
  source: EvalSource;
  justification: string;
  verification_externe_requise?: string | null;
}

export interface QuestionNotation {
  id: number;
  intitule: string;
  bareme_max: number;
  score: number | null;
  statut: NotationStatut;
  source: EvalSource;
  justification: string;
  hors_ia?: boolean;
}

export interface Evaluation {
  dossier_id: string;
  evaluateur_ia: { modele: string; version_skill_eligibilite: string; version_skill_notation: string };
  horodatage: { debut: string; fin: string };
  phase_eligibilite: {
    verdict: "ELIGIBLE" | "INELIGIBLE" | "ELIGIBILITE_INCERTAINE";
    criteres: CritereEligibilite[];
    motifs_rejet_declenches?: string[];
  };
  phase_notation?: {
    questions: QuestionNotation[];
    score_total_ia: number;
    score_max_ia: number;
    score_max_total: number;
  };
  commentaires_internes?: string[];
  synthese: {
    points_forts: string[];
    points_vigilance: string[];
    verifications_externes: string[];
  };
  review?: {
    validee_par?: string;
    validee_le?: string;
    questions_hors_ia?: { question_id: number; score: number; commentaire: string }[];
    /**
     * Override par un humain de la note IA d'une question normalement scorable
     * par IA. Quand un opérateur n'est pas d'accord avec Claude, il met sa note
     * et sa raison ici. La note finale = score_human, score_ia est conservé pour audit.
     */
    overrides_ia?: {
      question_id: number;
      score_ia: number | null;
      score_human: number;
      raison: string;
      par: string;
      le: string;
    }[];
    /**
     * Override d'un statut d'éligibilité (ELG-X). Idem mais pour ELG.
     */
    overrides_eligibilite?: {
      critere_id: string;
      statut_ia: string | null;
      statut_human: string;
      raison: string;
      par: string;
      le: string;
    }[];
    score_final_total?: number;
  };
}

export const QUESTIONS_HORS_IA = [15, 16, 18, 23, 24, 26, 27, 33, 38, 39, 40, 42, 43, 47, 48, 49];

// ===== Skills + Propositions =====

export interface SkillEntry {
  scope: "global" | "perso" | "proposition";
  owner?: string;
  filename: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
  size: number;
  modifiedAt: number;
}

export type FileKind = "pdf" | "xlsx" | "docx" | "image" | "other";
export interface FileEntry {
  name: string;
  size: number;
  kind: FileKind;
  absPath?: string;
}

export interface VeriteSummary {
  reference: string | null;
  verdict_humain?: "ELIGIBLE" | "INELIGIBLE";
  score_humain?: number;
  score_min?: number;
  score_max?: number;
  nb_evaluateurs?: number;
}

export interface PropositionEntry extends SkillEntry {
  scope: "proposition";
  auteur?: string;
  date?: string;
  affecte?: string;
  statut?: "en_attente" | "promu" | "rejete";
  dossier_declencheur?: string;
  raison?: string;
}
