/**
 * Types partagés pour les rapports de calibrage OIF-Eval.
 * Utilisés par scripts/calibrer.ts pour générer le JSON, par server/calibrage-reports.ts
 * pour le servir, et par les composants UI pour l'afficher.
 */

export interface CalibrageBiaisElg {
  id: string; // "ELG-7"
  intitule: string;
  desaccords: number;
  total: number;
  ia_oui_hum_non: number;
  ia_non_hum_oui: number;
  ia_ambigu: number;
  ia_non_trouve: number;
  pattern: string; // texte humain : "IA trop souvent AMBIGU (4/9)"
}

export interface CalibrageBiaisQ {
  id: number; // 10
  intitule: string;
  /** Barème max côté skill (référentiel IA, peut différer du xlsx). */
  bareme_max: number;
  hors_ia: boolean;
  n: number; // nb dossiers comparés
  /** Δ moyen brut IA - humain (pts du barème skill). Conservé pour rétrocompat. */
  delta_moyen: number;
  /** |Δ| moyen brut. Conservé pour rétrocompat. */
  delta_abs_moyen: number;
  ia_avg: number;
  humain_avg: number;
  /**
   * Barème max côté xlsx pour cette Q (peut différer du skill).
   * null si la Q n'est mappée à aucune colonne xlsx avec barème connu.
   * Présent à partir du rapport_version 2.
   */
  bareme_xlsx_max?: number | null;
  /** Score IA moyen normalisé en pourcentage du barème skill. rapport_version 2+. */
  ia_pct?: number;
  /** Score humain moyen normalisé en pourcentage du barème xlsx. rapport_version 2+. */
  humain_pct?: number;
  /** Δ en points de pourcentage : ia_pct - humain_pct. rapport_version 2+. */
  delta_pct?: number;
  /** |Δ| en points de pourcentage. rapport_version 2+. */
  delta_abs_pct?: number;
}

/**
 * Coût et tokens d'une évaluation IA (mode --import). Récupéré via
 * GET /api/runs/:runId/usage à la fin du run Claude. Optionnel : les
 * anciens rapports n'ont pas ce champ.
 */
export interface CalibrageDossierCout {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cost_usd: number;
  model: string;
  duration_ms: number;
}

export interface CalibrageDossierComparison {
  id: string;
  reference: string | null;
  nom: string;

  verdict_ia?: string;
  verdict_humain?: "ELIGIBLE" | "INELIGIBLE";
  match_eligibilite?: boolean;
  /** Coût IA pour ce dossier (mode --import uniquement). */
  cout?: CalibrageDossierCout;

  elg_diff: {
    id: string;
    intitule: string;
    statut_ia: string;
    statut_humain: "OUI" | "NON" | "?";
    match: boolean;
    justification_ia?: string;
  }[];
  elg_match_count: number;
  elg_total_count: number;

  score_ia?: number;
  score_humain_moyen?: number;
  score_humain_min?: number;
  score_humain_max?: number;
  delta_score?: number;
  nb_evaluateurs?: number;
  /**
   * Score IA sur les questions IA-évaluables matchées uniquement (hors_ia exclues).
   * Comparable à score_humain_ia_matchees sur le même périmètre.
   */
  score_ia_matchees?: number;
  /**
   * Score humain sur les mêmes questions IA-évaluables matchées.
   * Seul chiffre comparable à score_ia_matchees.
   */
  score_humain_ia_matchees?: number;
  /** Delta correct sur périmètre IA uniquement : score_ia_matchees - score_humain_ia_matchees. */
  delta_ia_matchees?: number;

  q_diff: {
    id: number;
    intitule: string;
    bareme_max: number;
    score_ia: number | null;
    score_humain_moyen: number | null;
    delta: number | null;
    matched_libelle?: string;
    hors_ia?: boolean;
    /** Barème max côté xlsx (ex: 3) si différent du skill (ex: 2). v2+. */
    bareme_xlsx_max?: number | null;
    /** Δ normalisé en pts de % : (ia/skill - hum/xlsx) * 100. v2+. */
    delta_pct?: number | null;
  }[];

  has_eval: boolean;
  has_verite: boolean;
  duree_evaluation_s?: number;
  modele_ia?: string;
  erreur?: string;
}

export interface CalibrageReportJson {
  meta: {
    timestamp: string; // ISO date du moment où le rapport a été généré
    modele_ia: string;
    nb_dossiers: number; // dossiers exploités dans la comparaison
    duree_moyenne_s: number;
    rapport_version: number; // 1
  };
  synthese: {
    accord_eligibilite: { ok: number; total: number; pct: number };
    /**
     * Δ score moyen brut (pts du score total). Conservé pour rétrocompat ; les
     * rapports v2+ exposent aussi `delta_score_moyen_pct` qui est plus
     * exploitable quand le barème xlsx diffère du barème skill.
     */
    delta_score_moyen: number;
    delta_score_abs_moyen: number;
    /**
     * Δ score moyen normalisé en points de pourcentage (présent à partir du
     * rapport_version 2). Calcul : moyenne sur dossiers de
     * (score_ia / score_max_ia - score_humain / max_xlsx) * 100.
     */
    delta_score_moyen_pct?: number;
    /** |Δ| moyen en points de pourcentage. rapport_version 2+. */
    delta_score_abs_moyen_pct?: number;
    delta_distribution: { petit: number; moyen: number; grand: number };
    /**
     * Taux de similitude IA vs humain sur les questions IA uniquement (hors_ia exclues).
     * = 100 - delta_abs_moyen_ia_pct. Indicateur principal de qualite calibrage.
     * Cible : >= 90%.
     */
    similitude_ia_pct?: number;
    /** |Delta| absolu moyen en pts % sur les questions IA uniquement. */
    delta_ia_abs_moyen_pct?: number;
  };
  biais_elg: CalibrageBiaisElg[];
  biais_q: CalibrageBiaisQ[];
  dossiers: CalibrageDossierComparison[];
  recommandations: {
    elg: { id: string; intitule: string; recommandation: string }[];
    notation: { id: number; intitule: string; recommandation: string }[];
  };
  /** Couverture du skill par le xlsx humain (mode --import uniquement). */
  coverage?: {
    /** Nombre total de Q définies dans le skill (typiquement 49). */
    qSkillTotal: number;
    /** Nombre de Q effectivement présentes dans biais_q (avec n >= 1). */
    qDansRapport: number;
    /** Nombre de Q marquées hors_ia dans le skill. */
    qHorsIa: number;
    /** Nombre de Q non couvertes par une colonne xlsx ET non hors_ia. */
    qNonMatchees: number;
  };
  /**
   * Coût total et projections prod (mode --import). Calculé à partir des
   * `cout` agrégés sur tous les dossiers évalués. Optionnel : les anciens
   * rapports n'ont pas ce champ.
   */
  couts?: {
    total_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read: number;
    total_cache_create: number;
    /** Ratio cache_read / (input + cache_read), 0..1. */
    cache_hit_ratio: number;
    cost_par_dossier_moyen: number;
    cost_par_dossier_min: number;
    cost_par_dossier_max: number;
    duree_moyenne_s: number;
    /** Modèle dominant utilisé (le plus fréquent sur les dossiers évalués). */
    modele_dominant: string;
    /**
     * Projections prod, parallélisme = 3 (limite MAX_CONCURRENT_EVALUATIONS).
     */
    projections: {
      nb_dossiers_296: { cost_usd: number; duree_h: number };
      nb_dossiers_2000: { cost_usd: number; duree_h: number };
    };
  };
  /** Bandeau d'alerte global affiché en haut du rapport (mapping insuffisant, etc.). */
  alerte?: string;
  /** Avertissements détaillés accumulés pendant la génération du rapport. */
  warnings?: string[];
}

/** Résumé d'un rapport pour la liste UI (sans le détail par dossier). */
export interface CalibrageReportSummary {
  filename: string;
  has_json: boolean;
  timestamp?: string;
  modele_ia?: string;
  nb_dossiers?: number;
  accord_pct?: number;
  delta_score_moyen?: number;
  delta_score_abs_moyen?: number;
  duree_moyenne_s?: number;
  /** Coût total USD du calibrage (présent si le rapport a un bloc `couts`). */
  total_cost_usd?: number;
  /** Total tokens (input + output + caches) consommés. */
  total_tokens?: number;
  /** Taux de similitude IA vs humain sur questions IA uniquement (0-100). Indicateur principal. */
  similitude_ia_pct?: number;
  size_bytes: number;
}
