"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listSkills, updateSkill } from "@/lib/client";
import type { SkillEntry } from "@/lib/types";

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [selected, setSelected] = useState<SkillEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const { global } = await listSkills();
      setSkills(global);
      if (selected) {
        const fresh = global.find((s) => s.filename === selected.filename);
        if (fresh) {
          setSelected(fresh);
          setDraft(fresh.raw);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onSave() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const slug = selected.filename.replace(/\.skill\.md$|\.md$/, "");
      await updateSkill(slug, draft);
      setInfo("Skill enregistré.");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 16 }}>
        <Link href="/runs" style={{ fontSize: 13, color: "var(--muted)" }}>
          ← Retour
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginTop: 8 }}>Skills</h1>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
        <aside>
          {skills.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Aucun skill. Pose un fichier `.skill.md` dans
              <code> skills-template/_global/</code> et relance `npm run deploy-data`.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {skills.map((s) => (
                <li key={s.filename} style={{ marginBottom: 4 }}>
                  <button
                    onClick={() => {
                      setSelected(s);
                      setDraft(s.raw);
                      setInfo(null);
                      setError(null);
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      background:
                        selected?.filename === s.filename
                          ? "var(--subtle)"
                          : "transparent",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    {s.filename}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section>
          {selected ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={28}
                style={{
                  width: "100%",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  padding: 12,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                }}
              />
              <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={onSave} disabled={saving}>
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </button>
                {info && (
                  <span style={{ color: "var(--green-fg)", fontSize: 13 }}>{info}</span>
                )}
                {error && (
                  <span style={{ color: "var(--red-fg)", fontSize: 13 }}>{error}</span>
                )}
              </div>
            </>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 14 }}>
              Sélectionne un skill à gauche pour l&apos;éditer.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
