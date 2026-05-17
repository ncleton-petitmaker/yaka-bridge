/**
 * Types pour les bundles de calibrage importés par l'utilisateur.
 *
 * Un bundle = un xlsx au format OIF (notes humaines) + un jeu de dossiers PDF.
 * L'utilisateur uploade un ZIP, on parse, on valide, et on stocke dans
 * data/calibrage/imports/<importId>/. Le script de calibrage lit ensuite ce
 * dossier pour lancer les évaluations IA et les comparer aux scores humains.
 */

/**
 * Description d'une colonne notée du xlsx d'origine, avec son mapping fuzzy
 * vers une question (Q1..Q49) du skill de notation actif. Permet de comparer
 * notes humaines et notes IA même quand l'ordre des colonnes du xlsx ne suit
 * pas l'ordre des Q du skill, ou quand certaines Q ne sont pas notées.
 */
export interface ColonneXlsx {
  /** Index 0-based de la colonne dans la feuille xlsx (toutes colonnes confondues). */
  positionXlsx: number;
  /** Libellé exact lu en row 1 du xlsx (avec le suffixe "(/N)" éventuel). */
  libelleXlsx: string;
  /** Barème max parsé depuis le libellé "(/N)" ou row 2 si numérique. null sinon. */
  baremeXlsxMax: number | null;
  /** Numéro de la Q du skill matchée (1..49), null si aucun match suffisant. */
  matchedSkillQId: number | null;
  /** Score Jaccard du meilleur match (0 à 1). 0 si pas de match. */
  matchScore: number;
  /** Avertissement explicite si match faible ou inexistant, null si match >= 0.6. */
  matchWarning: string | null;
}

export interface CalibrageImport {
  /** Identifiant court basé sur l'horodatage (ex: 2026-05-09-14-23-15). */
  importId: string;
  /** ISO 8601, créé à l'upload. */
  createdAt: string;
  /** Nom du fichier ZIP d'origine, pour rappel à l'utilisateur. */
  bundleName: string;
  /** Nombre de dossiers détectés et stockés. */
  totalDossiers: number;
  /** Liste détaillée par dossier. */
  dossiers: CalibrageImportDossier[];
  /**
   * Mapping libellé colonne xlsx -> Q skill, partagé entre tous les dossiers
   * (le xlsx est unique). Sert au script de calibrage pour lire
   * `scoresHumains["col_<positionXlsx>"]` et le comparer à la Q IA matchée.
   *
   * Optionnel pour rétrocompatibilité avec les imports antérieurs au fix
   * mapping (ils n'ont pas ce champ et seront refusés en génération de
   * rapport avec un message explicite).
   */
  colonnes?: ColonneXlsx[];
  /** Avertissements non bloquants (références sans dossier, etc.). */
  warnings: string[];
}

export interface CalibrageImportDossier {
  /** Référence hex 10 caractères extraite de l'xlsx (ex: 001f9dc70c). */
  reference: string;
  nom: string;
  prenom: string;
  /**
   * Scores humains indexés par position dans le xlsx (clé = "col_<N>").
   * Les anciens imports utilisaient "Q1", "Q2"... ; pour rétrocompatibilité
   * la lecture côté script tolère les deux formes mais refuse de générer le
   * rapport si `colonnes` est absent (cf. CalibrageImport.colonnes).
   */
  scoresHumains: Record<string, number | null>;
  /** Moyenne générale lue depuis l'xlsx (colonne dédiée), ou null si absente. */
  moyenneHumaine: number | null;
  /** True si le sous-dossier PDF correspondant existe dans le ZIP. */
  hasFolder: boolean;
  /** Nombre de fichiers PDF trouvés dans le sous-dossier. */
  pdfCount: number;
}

/**
 * Progression émise par le script de calibrage à chaque dossier terminé.
 * Émise sur stdout sous la forme "PROGRESS <json>" pour parsing serveur.
 */
export interface CalibrageProgress {
  /** Nombre de dossiers traités jusqu'ici. */
  done: number;
  /** Nombre total de dossiers à traiter. */
  total: number;
  /** Nom (ou id) du dernier dossier dont l'évaluation vient de finir. */
  lastDossier: string | null;
  /** ISO 8601 du début du run. */
  startedAt: string;
  /** Estimation du temps restant en secondes, ou null si pas calculable. */
  etaSeconds: number | null;
}
