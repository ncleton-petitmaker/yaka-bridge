"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getApiMode } from "@/lib/api-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

export function CloudAuthGate({ children }: { children: ReactNode }) {
  const isCloud = getApiMode() === "cloud";
  const pathname = usePathname();
  const isBridgeCallback = pathname === "/auth/bridge/callback";
  const supabase = getSupabaseBrowserClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isCloud && !isBridgeCallback);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isBridgeCallback) {
      setLoading(false);
      return;
    }
    if (!isCloud || !supabase) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [isBridgeCallback, isCloud, supabase]);

  useEffect(() => {
    if (!isCloud) return;
    const onInvalidAuth = () => {
      setSession(null);
      setMessage("Session expirée. Reconnectez-vous.");
    };
    window.addEventListener("app-auth-invalid", onInvalidAuth);
    return () => window.removeEventListener("app-auth-invalid", onInvalidAuth);
  }, [isCloud]);

  if (!isCloud || isBridgeCallback) return <>{children}</>;

  if (!supabase) {
    return (
      <main className="cloud-auth-shell">
        <section className="cloud-auth-panel">
          <h1>Configuration cloud manquante</h1>
          <p>
            Définissez `NEXT_PUBLIC_SUPABASE_URL` et
            `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` avant de lancer l'app cloud.
          </p>
        </section>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="cloud-auth-shell">
        <section className="cloud-auth-panel">
          <h1>Connexion</h1>
          <p>Vérification de la session Supabase.</p>
        </section>
      </main>
    );
  }

  if (session) return <>{children}</>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase!.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cloud-auth-shell">
      <section className="cloud-auth-panel">
        <h1>Connexion</h1>
        <form onSubmit={submit} className="cloud-auth-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Mot de passe
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Connexion..." : "Se connecter"}
          </button>
          {message && <p>{message}</p>}
        </form>
      </section>
    </main>
  );
}
