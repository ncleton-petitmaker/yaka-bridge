"use client";

import { useState } from "react";
import Link from "next/link";
import { BridgeMascot3D, type BridgeMascotMode } from "@/components/BridgeMascot3D";
import { Mark } from "@/components/Mark";

const modes: Array<{
  id: BridgeMascotMode;
  label: string;
  detail: string;
}> = [
  {
    id: "assembled",
    label: "Complet",
    detail: "Silhouette finale du robot-pont.",
  },
  {
    id: "layers",
    label: "Calques",
    detail: "Source, pont, tete et cible se separent.",
  },
  {
    id: "flow",
    label: "Flux",
    detail: "Les modules traversent le bridge.",
  },
  {
    id: "head",
    label: "Tete",
    detail: "Le regard suit le pointeur.",
  },
];

export default function BridgeMascotPage() {
  const [mode, setMode] = useState<BridgeMascotMode>("assembled");
  const activeMode = modes.find((item) => item.id === mode) ?? modes[0];

  return (
    <div className="app">
      <header className="bridge-mascot-topbar">
        <Link href="/dashboard" className="bridge-mascot-brand">
          <Mark size={22} />
          <span>Bridge ERP Demo</span>
        </Link>
        <nav aria-label="Navigation prototype">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/runs">Achats</Link>
        </nav>
      </header>
      <main className="bridge-mascot-page">
        <section className="bridge-mascot-stage" aria-label="Mascotte 3D Yaka Bridge">
          <BridgeMascot3D mode={mode} />
          <div className="bridge-mascot-stage-caption" aria-live="polite">
            <span className="eyebrow">Yaka Bridge</span>
            <h1>Robot-pont interactif</h1>
            <p>{activeMode.detail}</p>
          </div>
        </section>

        <aside className="bridge-mascot-panel" aria-label="Versions de decomposition">
          <div>
            <span className="eyebrow">Prototype 3D</span>
            <h2>Mascotte Bridge</h2>
            <p>
              Une image decoupee en objets: outils metier, pont, modules, tete
              et sortie Codex.
            </p>
          </div>

          <div className="bridge-mascot-mode-list" role="group" aria-label="Mode de vue">
            {modes.map((item) => {
              const labelId = `bridge-mascot-mode-${item.id}-label`;
              const detailId = `bridge-mascot-mode-${item.id}-detail`;

              return (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === mode ? "bridge-mascot-mode active" : "bridge-mascot-mode"}
                  onClick={() => setMode(item.id)}
                  aria-pressed={item.id === mode}
                  aria-labelledby={labelId}
                  aria-describedby={detailId}
                >
                  <span id={labelId}>{item.label}</span>
                  <small id={detailId}>{item.detail}</small>
                </button>
              );
            })}
          </div>

          <div className="bridge-mascot-layer-map" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </aside>
      </main>
    </div>
  );
}
