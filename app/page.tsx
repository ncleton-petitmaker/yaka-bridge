import { redirect } from "next/navigation";

/**
 * Route racine — redirige immédiatement vers le dashboard module (`/dashboard`).
 *
 * On évite le landing 2-colonnes "Hero + cards" qui forçait l'utilisateur à
 * faire un clic mort ("Nouveau run") avant d'arriver à l'interface utile.
 * Toute app scaffoldée à partir de ce template a un dashboard métier comme
 * surface principale, puis des workspaces module dédiés.
 *
 * Server component → redirect côté serveur, pas de flash de contenu.
 *
 * Note pour ui-page-generator : ne pas ré-introduire un landing ici. Si une
 * app métier veut une vraie home avec dashboard agrégé, créer une route
 * dédiée (`/home`, `/overview`…) et mettre à jour ce redirect en conséquence.
 */
export default function HomePage(): never {
  redirect("/dashboard");
}
