"use client";
import { useCallback, useEffect, useState } from "react";
import { Mark } from "@/components/Mark";

interface AppConfig {
  currentUser?: string;
  isAdmin?: boolean;
  sharedSkillsDir?: string;
  inputDir?: string;
  outputDir?: string;
}

type Step = "welcome" | "admin" | "dossiers" | "campagne" | "done";

/**
 * Mini-wizard d'onboarding au premier lancement de OIF-Eval.
 * Apparaît en plein écran tant que cfg.currentUser n'est pas défini.
 * 4 étapes : bienvenue+prénom, rôle admin, dossier partagé (optionnel), récap.
 */
export function OnboardingWizard() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>("welcome");
  const [prenom, setPrenom] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [storageMode, setStorageMode] = useState<"shared" | "manual">("shared");
  const [sharedSkillsDir, setSharedSkillsDir] = useState("");
  const [inputDir, setInputDir] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [hasElectronDialog, setHasElectronDialog] = useState(false);
  const [activeCampaign, setActiveCampaign] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [newCampaignLabel, setNewCampaignLabel] = useState("");
  const [newCampaignBusy, setNewCampaignBusy] = useState(false);
  const [newCampaignError, setNewCampaignError] = useState<string | null>(null);

  // Récupérer la campagne active dès que l'étape "campagne" est atteinte
  // (pour ne pas hardcoder le nom dans l'UI).
  const refreshActiveCampaign = useCallback(() => {
    setCampaignLoading(true);
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((j: { campaigns?: Array<{ id: string; label: string }>; activeId?: string | null }) => {
        const active = j.campaigns?.find((c) => c.id === j.activeId);
        setActiveCampaign(active ? { id: active.id, label: active.label } : null);
      })
      .catch(() => setActiveCampaign(null))
      .finally(() => setCampaignLoading(false));
  }, []);

  useEffect(() => {
    if (step !== "campagne") return;
    refreshActiveCampaign();
  }, [step, refreshActiveCampaign]);

  async function createCampaignFromWizard() {
    const label = newCampaignLabel.trim();
    if (!label) return;
    setNewCampaignBusy(true);
    setNewCampaignError(null);
    try {
      // ID : slug du label (ex "FAE 8e édition" → "fae-8e-edition")
      const id = label
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      if (!id) throw new Error("Le nom de campagne doit contenir au moins un caractère alphanumérique.");
      const r = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, label, activate: true }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({ error: "" }))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setNewCampaignLabel("");
      refreshActiveCampaign();
    } catch (err) {
      setNewCampaignError((err as Error).message);
    } finally {
      setNewCampaignBusy(false);
    }
  }

  useEffect(() => {
    setHasElectronDialog(
      typeof window !== "undefined" &&
        Boolean(
          (window as unknown as { oifEval?: { selectDirectory?: unknown } }).oifEval
            ?.selectDirectory
        )
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;

    function tryFetch() {
      attempts++;
      fetch("/api/app-config")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((j: { config?: AppConfig }) => {
          if (cancelled) return;
          if (!j.config?.currentUser) {
            setOpen(true);
          }
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          // Daemon pas encore prêt : retry jusqu'à 10x (toutes les 1.5s)
          // au lieu de skipper silencieusement le wizard.
          if (attempts < 10) {
            setTimeout(tryFetch, 1500);
          } else {
            // Daemon vraiment injoignable : ouvrir le wizard quand même
            // pour que l'utilisateur ne reste pas avec une app vide.
            setOpen(true);
            setLoading(false);
          }
        });
    }

    tryFetch();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pickDir(
    setter: (v: string) => void,
    title: string,
    current: string
  ) {
    const w = window as unknown as {
      oifEval?: {
        selectDirectory?: (opts?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
      };
    };
    if (!w.oifEval?.selectDirectory) {
      alert(
        "Le sélecteur de dossier n'est pas disponible.\n\nTapez le chemin manuellement dans le champ (par exemple : C:\\Users\\<vous>\\OneDrive - OIF\\FAE7e), puis cliquez Suivant."
      );
      return;
    }
    try {
      const path = await w.oifEval.selectDirectory({
        title,
        defaultPath: current || undefined,
      });
      if (path) setter(path);
    } catch (e) {
      alert(
        "Erreur sélecteur de dossier : " +
          (e as Error).message +
          "\n\nTapez le chemin manuellement."
      );
    }
  }

  async function finish() {
    setSaving(true);
    try {
      // setup-shared-dir a déjà été appelé à l'étape "dossiers" (Suivant →).
      // Ici on enregistre juste le profil. Les 4 chemins sont déjà persistés.
      await fetch("/api/app-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentUser: prenom.trim(),
          isAdmin,
          storageMode,
        }),
      });
      setOpen(false);
      // Forcer un refresh de la page courante pour que le header etc. récupèrent le profil
      window.location.reload();
    } catch (e) {
      console.error(e);
      alert(`Erreur d'enregistrement : ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(28, 27, 26, 0.55)",
        backdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "fade-in 200ms ease-out",
      }}
    >
      <div
        className="pane"
        style={{
          width: "100%",
          maxWidth: 680,
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          padding: 28,
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          animation: "pop-in 220ms cubic-bezier(0.21, 1.02, 0.73, 1)",
        }}
      >
        <Steps current={step} />

        {step === "welcome" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Mark size={48} />
              <div>
                <h1
                  style={{
                    fontFamily: "var(--serif)",
                    fontWeight: 600,
                    fontSize: 22,
                    color: "var(--text-strong)",
                    letterSpacing: "-0.01em",
                    marginBottom: 2,
                  }}
                >
                  Bienvenue dans OIF-Eval
                </h1>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Outil d&apos;évaluation des candidatures FAE 7e · OIF
                </div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
              <strong>À quoi ça sert ?</strong> 4 étapes rapides (≈ 1 min) pour
              configurer l&apos;app à votre profil et à votre organisation. Vous
              pourrez tout modifier après dans <strong>Paramètres</strong>.
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>
                Quel est votre prénom ?
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Il apparaîtra à côté de vos propositions de règles et à côté de vos
                évaluations terminées, pour que l&apos;équipe sache qui les a faites.
              </span>
              <input
                type="text"
                value={prenom}
                onChange={(e) => setPrenom(e.target.value)}
                placeholder="Alice"
                autoFocus
                style={{ fontSize: 14, padding: "8px 12px", marginTop: 4 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && prenom.trim()) {
                    setStep("admin");
                  }
                }}
              />
            </label>
            <Footer
              left={null}
              right={
                <button
                  className="primary"
                  disabled={!prenom.trim()}
                  onClick={() => setStep("admin")}
                  style={{
                    fontSize: 13,
                    padding: "7px 16px",
                    cursor: prenom.trim() ? "pointer" : "not-allowed",
                    opacity: prenom.trim() ? 1 : 0.4,
                  }}
                >
                  Suivant →
                </button>
              }
            />
          </>
        )}

        {step === "admin" && (
          <>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 20,
                color: "var(--text-strong)",
                letterSpacing: "-0.01em",
              }}
            >
              Êtes-vous admin de l&apos;équipe ?
            </h2>
            <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
              <strong>À quoi ça sert ?</strong> Au fil des évaluations, chaque
              membre de l'équipe peut proposer une nouvelle règle de classement à appliquer
              (par exemple :{" "}
              <em>« on doit refuser les récépissés qui sont en fait des attestations »</em>).
              <br />
              <br />
              <strong>L&apos;admin</strong> reçoit ces propositions et décide de les
              valider ou non. Si la règle est validée, elle devient officielle et toute
              l&apos;équipe en bénéficie au prochain dossier.
              <br />
              <br />
              Une seule personne joue ce rôle par mission, désignée par
              l&apos;équipe OIF.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Choice
                checked={!isAdmin}
                onChange={() => setIsAdmin(false)}
                label="Non, je fais partie de l'équipe"
                hint="Je traite des dossiers et propose des règles à l'admin si je vois quelque chose à améliorer."
              />
              <Choice
                checked={isAdmin}
                onChange={() => setIsAdmin(true)}
                label="Oui, je suis admin"
                hint="Je valide ou rejette les propositions de règles que les membres de l'équipe envoient. Je peux aussi modifier les règles officielles directement."
              />
            </div>
            <Footer
              left={
                <button
                  className="ghost"
                  onClick={() => setStep("welcome")}
                  style={{ fontSize: 13, padding: "7px 14px", cursor: "pointer" }}
                >
                  ← Retour
                </button>
              }
              right={
                <button
                  className="primary"
                  onClick={async () => {
                    // Sauvegarder immédiatement isAdmin pour que l'étape suivante
                    // (création de campagne) puisse vérifier le droit côté serveur.
                    // Sans ça, l'API /api/campaigns rejette avec "réservé à l'admin"
                    // car la config n'a pas encore été persistée par finish().
                    try {
                      await fetch("/api/app-config", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isAdmin }),
                      });
                    } catch {
                      // non bloquant : sera retentée dans finish()
                    }
                    setStep("dossiers");
                  }}
                  style={{ fontSize: 13, padding: "7px 16px", cursor: "pointer" }}
                >
                  Suivant →
                </button>
              }
            />
          </>
        )}

        {step === "dossiers" && (
          <>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 20,
                color: "var(--text-strong)",
                letterSpacing: "-0.01em",
              }}
            >
              Vos dossiers de travail
            </h2>
            <div
              style={{
                fontSize: 13,
                color: "var(--text)",
                lineHeight: 1.6,
              }}
            >
              Comment l&apos;équipe partage les règles, les évaluations et le journal.
              Choisissez votre mode de partage. Tout est modifiable plus tard dans
              <strong> Paramètres &gt; Stockage</strong>.
            </div>

            <WizardModeChoice
              label="Dossier synchronisé (recommandé)"
              sub="OneDrive · SharePoint · Dropbox · NAS · SMB"
              desc="Tous les évaluateurs pointent vers le même dossier ; le service de synchronisation propage les fichiers automatiquement."
              checked={storageMode === "shared"}
              onChange={() => setStorageMode("shared")}
            />
            <WizardModeChoice
              label="Import / Export manuel (sans serveur partagé)"
              sub="Échange par fichiers ZIP via Teams ou email"
              desc="Vos données restent locales. L'admin diffuse les règles en pack ZIP, vous renvoyez vos évaluations en pack ZIP en fin de journée."
              checked={storageMode === "manual"}
              onChange={() => setStorageMode("manual")}
            />

            {storageMode === "shared" && (
              <>
                <WizardDirField
                  label="Dossier racine partagé"
                  hint="Le dossier que toute l'équipe utilise. L'app crée automatiquement les sous-dossiers (skills/, candidatures/, evaluations/, audit-log/, calibrage/) s'ils n'existent pas. Si le dossier est déjà utilisé par un collègue, vous vous branchez dessus sans rien dupliquer."
                  value={sharedSkillsDir}
                  onChange={setSharedSkillsDir}
                  onPick={
                    hasElectronDialog
                      ? () =>
                          pickDir(
                            setSharedSkillsDir,
                            "Choisir le dossier partagé OIF",
                            sharedSkillsDir
                          )
                      : undefined
                  }
                  placeholder="ex. /Volumes/Partage-OIF/FAE-7e"
                />
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                    paddingTop: 4,
                  }}
                >
                  Pas besoin de configurer plus : les chemins individuels (candidatures, évaluations, journal RGPD, skills) sont créés et configurés automatiquement à partir de ce dossier racine. Vous pourrez les ajuster un par un plus tard dans Paramètres &gt; Stockage si nécessaire.
                </div>
              </>
            )}

            {storageMode === "manual" && (
              <div
                style={{
                  padding: "12px 14px",
                  background: "var(--accent-tint)",
                  border:
                    "1px solid color-mix(in srgb, var(--accent) 30%, var(--border))",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: "var(--text)",
                }}
              >
                <strong style={{ color: "var(--text-strong)" }}>Mode autonome activé.</strong>{" "}
                Aucun dossier partagé à choisir. Vos règles et évaluations restent
                stockées localement à côté de l&apos;app. Vous échangerez avec l&apos;admin
                via des packs ZIP : il vous enverra un &quot;pack admin&quot; régulièrement
                (skills + propositions), vous lui renverrez un &quot;pack évaluations&quot;
                en fin de journée. Tout se gère depuis <strong>Paramètres &gt; Stockage</strong>.
              </div>
            )}

            <Footer
              left={
                <button
                  className="ghost"
                  onClick={() => setStep("admin")}
                  style={{ fontSize: 13, padding: "7px 14px", cursor: "pointer" }}
                >
                  ← Retour
                </button>
              }
              right={
                <button
                  className="primary"
                  onClick={async () => {
                    // CRITIQUE : appeler setup-shared-dir maintenant (avant
                    // l'étape Campagne) pour que la config sharedSkillsDir soit
                    // déjà à jour quand /api/campaigns sera interrogé. Sinon
                    // l'étape Campagne lit l'ancien sharedSkillsDir et croit
                    // qu'aucune campagne n'existe alors que le NAS en a une.
                    const root = sharedSkillsDir.trim();
                    if (storageMode === "shared" && root) {
                      try {
                        const r = await fetch("/api/setup-shared-dir", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            rootDir: root,
                            currentUser: prenom.trim(),
                          }),
                        });
                        if (!r.ok) {
                          const j = (await r.json().catch(() => ({}))) as {
                            error?: string;
                          };
                          alert(
                            `Erreur dossier de stockage : ${j.error || `HTTP ${r.status}`}`
                          );
                          return;
                        }
                      } catch (err) {
                        alert(
                          `Erreur dossier de stockage : ${(err as Error).message}`
                        );
                        return;
                      }
                    }
                    setStep("campagne");
                  }}
                  disabled={storageMode === "shared" && !sharedSkillsDir.trim()}
                  style={{
                    fontSize: 13,
                    padding: "7px 16px",
                    cursor:
                      storageMode === "shared" && !sharedSkillsDir.trim()
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      storageMode === "shared" && !sharedSkillsDir.trim()
                        ? 0.5
                        : 1,
                  }}
                  title={
                    storageMode === "shared" && !sharedSkillsDir.trim()
                      ? "Choisissez d'abord un dossier racine partagé"
                      : undefined
                  }
                >
                  Suivant →
                </button>
              }
            />
          </>
        )}

        {step === "campagne" && (
          <>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 22,
                color: "var(--text-strong)",
                marginBottom: 6,
                letterSpacing: "-0.01em",
              }}
            >
              Campagne d&apos;évaluation
            </h2>
            {!campaignLoading && !activeCampaign && isAdmin && (
              <>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text)",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  Aucune campagne active n&apos;a été détectée. En tant
                  qu&apos;admin, créez la première campagne maintenant.
                  Choisissez un nom clair (ex. <em>FAE 7e édition</em> ou{" "}
                  <em>FAE 8e édition 2027</em>).
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input
                    type="text"
                    value={newCampaignLabel}
                    onChange={(e) => setNewCampaignLabel(e.target.value)}
                    placeholder="ex. FAE 7e édition"
                    disabled={newCampaignBusy}
                    style={{
                      flex: 1,
                      fontSize: 13,
                      padding: "8px 12px",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newCampaignLabel.trim()) {
                        createCampaignFromWizard();
                      }
                    }}
                  />
                  <button
                    className="primary"
                    onClick={createCampaignFromWizard}
                    disabled={newCampaignBusy || !newCampaignLabel.trim()}
                    style={{
                      fontSize: 13,
                      padding: "8px 16px",
                      cursor:
                        newCampaignBusy || !newCampaignLabel.trim()
                          ? "not-allowed"
                          : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {newCampaignBusy ? "Création..." : "Créer cette campagne"}
                  </button>
                </div>
                {newCampaignError && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--red)",
                      padding: "8px 12px",
                      background: "var(--red-bg)",
                      border: "1px solid var(--red-border)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    Erreur : {newCampaignError}
                  </div>
                )}
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  La campagne sera créée vide. Vous pourrez la pré-remplir
                  depuis <strong>Paramètres &gt; Campagnes</strong> (édition
                  des critères ELG et questions de notation).
                </p>
              </>
            )}
            {!campaignLoading && !activeCampaign && !isAdmin && (
              <>
                <div
                  style={{
                    padding: "14px 16px",
                    background: "var(--amber-bg)",
                    border: "1px solid var(--amber-border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 13,
                    color: "var(--text)",
                    lineHeight: 1.6,
                  }}
                >
                  <strong style={{ color: "var(--text-strong)" }}>
                    Aucune campagne active n&apos;est encore configurée.
                  </strong>
                  <br />
                  Demandez à votre admin OIF de créer la campagne dans
                  l&apos;app, ou de partager le dossier déjà configuré par
                  l&apos;équipe. Vous pouvez continuer l&apos;installation,
                  l&apos;app récupérera automatiquement la campagne dès
                  qu&apos;elle sera disponible.
                </div>
                <button
                  className="ghost"
                  onClick={refreshActiveCampaign}
                  style={{
                    fontSize: 12,
                    padding: "6px 14px",
                    cursor: "pointer",
                    alignSelf: "flex-start",
                  }}
                >
                  Vérifier à nouveau
                </button>
              </>
            )}
            {campaignLoading && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  padding: "10px 0",
                }}
              >
                Vérification de la campagne active...
              </div>
            )}
            {!campaignLoading && activeCampaign && isAdmin && (
              <>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  Une <strong>campagne</strong>, c&apos;est une grille
                  d&apos;évaluation pour une édition donnée du fonds. Chaque
                  édition FAE peut avoir des critères différents (questions
                  ajoutées, pièces obligatoires modifiées, etc.). OIF-Eval
                  isole les campagnes pour que les évaluations passées restent
                  figées même quand la grille évolue.
                </p>
                <div
                  style={{
                    padding: "14px 16px",
                    background: "var(--accent-tint)",
                    border:
                      "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
                    borderRadius: "var(--radius-sm)",
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    alignItems: "center",
                    columnGap: 12,
                    rowGap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      border: "4px solid var(--accent)",
                      background: "var(--bg-panel)",
                      flexShrink: 0,
                    }}
                  />
                  <strong style={{ fontSize: 14, color: "var(--text-strong)" }}>
                    {activeCampaign?.label ?? "Chargement..."}
                  </strong>
                  <span
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--green)",
                      background: "var(--green-bg)",
                      padding: "2px 8px",
                      borderRadius: "var(--radius-sm)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Active par défaut
                  </span>
                  <div
                    style={{
                      gridColumn: "2 / span 2",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    Grille prête à l&apos;emploi : critères d&apos;éligibilité
                    + questions de notation, configurés pour cette édition. Les
                    autres évaluateurs verront automatiquement la même campagne
                    active.
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  Vous pourrez créer d&apos;autres campagnes (pour une édition
                  future) à tout moment depuis{" "}
                  <strong>Paramètres &gt; Campagnes</strong>. L&apos;admin
                  pourra cloner la campagne en cours, ajuster les critères, et
                  l&apos;activer pour toute l&apos;équipe.
                </p>
              </>
            )}
            {!campaignLoading && activeCampaign && !isAdmin && (
              <>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  Vous travaillerez sur la campagne <strong>active</strong>
                  {" "}choisie par votre admin. Pas besoin de la configurer ici :
                  l&apos;app récupère automatiquement la grille en vigueur quand
                  vous lancerez votre première évaluation.
                </p>
                <div
                  style={{
                    padding: "12px 14px",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border-soft)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                    color: "var(--text-muted)",
                    lineHeight: 1.55,
                  }}
                >
                  Campagne active actuellement :{" "}
                  <strong style={{ color: "var(--text-strong)" }}>
                    {activeCampaign.label}
                  </strong>
                  . Si l&apos;admin active une autre campagne (par exemple une
                  édition suivante), vous basculerez automatiquement sans rien
                  faire.
                </div>
              </>
            )}
            <Footer
              left={
                <button
                  className="ghost"
                  onClick={() => setStep("dossiers")}
                  style={{ fontSize: 13, padding: "7px 14px", cursor: "pointer" }}
                >
                  ← Retour
                </button>
              }
              right={
                <button
                  className="primary"
                  onClick={() => setStep("done")}
                  style={{ fontSize: 13, padding: "7px 16px", cursor: "pointer" }}
                >
                  Suivant →
                </button>
              }
            />
          </>
        )}

        {step === "done" && (
          <>
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontWeight: 600,
                fontSize: 20,
                color: "var(--text-strong)",
                letterSpacing: "-0.01em",
              }}
            >
              Récapitulatif
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "10px 14px",
                fontSize: 13,
                padding: "14px 16px",
                background: "var(--bg-subtle)",
                border: "1px solid var(--border-soft)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span style={{ color: "var(--text-muted)" }}>Prénom</span>
              <span style={{ fontWeight: 500, color: "var(--text-strong)" }}>{prenom}</span>
              <span style={{ color: "var(--text-muted)" }}>Rôle</span>
              <span style={{ fontWeight: 500, color: "var(--text-strong)" }}>
                {isAdmin ? "Admin" : "Membre de l'équipe"}
              </span>
              {(() => {
                // Le récap affiche les chemins effectifs déduits du dossier
                // racine choisi. Slug utilisateur pour candidatures/<user>/.
                const root = sharedSkillsDir.trim().replace(/[/\\]+$/, "");
                const sep =
                  root.includes("\\") && !root.includes("/") ? "\\" : "/";
                const slug = prenom
                  .trim()
                  .normalize("NFD")
                  .replace(/[̀-ͯ]/g, "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 40);
                const candidaturesPath = root
                  ? root + sep + "candidatures" + (slug ? sep + slug : "")
                  : "(local par défaut)";
                const evaluationsPath = root
                  ? root + sep + "evaluations"
                  : "(local par défaut)";
                const skillsPath = root
                  ? root + sep + "skills"
                  : "(local par défaut)";
                return (
                  <>
                    <span style={{ color: "var(--text-muted)" }}>
                      Mes candidatures
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--text)",
                        wordBreak: "break-all",
                      }}
                    >
                      {candidaturesPath}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}>
                      Évaluations
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--text)",
                        wordBreak: "break-all",
                      }}
                    >
                      {evaluationsPath}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}>
                      Règles partagées
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--text)",
                        wordBreak: "break-all",
                      }}
                    >
                      {skillsPath}
                    </span>
                  </>
                );
              })()}
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Vous pourrez tout modifier dans <strong>Paramètres</strong>.
            </p>
            <Footer
              left={
                <button
                  className="ghost"
                  onClick={() => setStep("campagne")}
                  style={{ fontSize: 13, padding: "7px 14px", cursor: "pointer" }}
                >
                  ← Retour
                </button>
              }
              right={
                <button
                  className="primary"
                  onClick={finish}
                  disabled={saving}
                  style={{
                    fontSize: 13,
                    padding: "7px 18px",
                    cursor: saving ? "not-allowed" : "pointer",
                    opacity: saving ? 0.5 : 1,
                  }}
                >
                  {saving ? "Sauvegarde…" : "Terminer ✓"}
                </button>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const order: Step[] = ["welcome", "admin", "dossiers", "campagne", "done"];
  const idx = order.indexOf(current);
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
      {order.map((s, i) => (
        <span
          key={s}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 999,
            background: i <= idx ? "var(--accent)" : "var(--border)",
            transition: "background 200ms ease",
          }}
        />
      ))}
    </div>
  );
}

function Footer({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 6,
        gap: 8,
      }}
    >
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

function Choice({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onChange}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 12,
        padding: "12px 14px",
        background: checked ? "var(--accent-tint)" : "var(--bg-subtle)",
        border: checked
          ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
          : "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 120ms ease",
      }}
    >
      <span
        style={{
          marginTop: 2,
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: checked ? "4px solid var(--accent)" : "1px solid var(--border-strong)",
          background: checked ? "var(--bg-panel)" : "transparent",
          flexShrink: 0,
        }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      </div>
    </button>
  );
}

function WizardDirField({
  label,
  hint,
  value,
  onChange,
  onPick,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onPick?: () => void;
  placeholder: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-strong)" }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2, lineHeight: 1.4 }}>
        {hint}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: "var(--mono)",
            padding: "6px 10px",
          }}
        />
        {onPick && (
          <button
            onClick={onPick}
            className="ghost"
            style={{ fontSize: 12, padding: "5px 12px", cursor: "pointer", flexShrink: 0 }}
          >
            Parcourir…
          </button>
        )}
      </div>
    </div>
  );
}

function WizardModeChoice({
  checked,
  onChange,
  label,
  sub,
  desc,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  sub: string;
  desc: string;
}) {
  return (
    <button
      onClick={onChange}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 12,
        padding: "12px 14px",
        background: checked ? "var(--accent-tint)" : "var(--bg-subtle)",
        border: checked
          ? "1px solid color-mix(in srgb, var(--accent) 50%, var(--border))"
          : "1px solid var(--border-soft)",
        borderRadius: "var(--radius-sm)",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 120ms ease",
      }}
    >
      <span
        style={{
          marginTop: 3,
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: checked ? "4px solid var(--accent)" : "1px solid var(--border-strong)",
          background: checked ? "var(--bg-panel)" : "transparent",
          flexShrink: 0,
        }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginTop: 2,
            marginBottom: 6,
          }}
        >
          {sub}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
    </button>
  );
}

