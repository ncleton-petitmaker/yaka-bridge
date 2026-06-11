import type { Metadata } from "next";
import "./globals.css";
import { CloudAuthGate } from "@/components/CloudAuthGate";
import { BridgeStatusProvider } from "@/components/BridgeStatusProvider";
import { OpenReplayProvider } from "@/components/OpenReplayProvider";
import { RuntimeHealthGuard } from "@/components/RuntimeHealthGuard";

export const metadata: Metadata = {
  title: "Bridge ERP Demo",
  description: "Template ERP modulaire cloud/bridge",
};

// Script inline qui applique data-theme avant le render pour éviter le FOUC.
const themeKey = "bridge-erp-demo:theme";
const themeInitScript = `(function(){try{var k='${themeKey}';var t=localStorage.getItem(k);if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else{document.documentElement.setAttribute('data-theme',matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icon-64.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+Pro:ital,wght@0,400;0,600;1,400&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body style={{ background: "var(--bg)", color: "var(--fg)" }}>
        <RuntimeHealthGuard />
        <CloudAuthGate>
          <OpenReplayProvider />
          <BridgeStatusProvider>
            {children}
          </BridgeStatusProvider>
        </CloudAuthGate>
      </body>
    </html>
  );
}
