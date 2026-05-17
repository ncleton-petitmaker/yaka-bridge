import { redirect } from "next/navigation";

/**
 * Route racine — redirige immédiatement vers la page de travail (`/runs`).
 *
 * On évite le landing 2-colonnes "Hero + cards" qui forçait l'utilisateur à
 * faire un clic mort ("Nouveau run") avant d'arriver à l'interface utile.
 * Toute app scaffoldée à partir de ce template a `/runs` comme surface de
 * travail principale (form de lancement + stream live + drawer detail).
 *
 * Server component → redirect côté serveur, pas de flash de contenu.
 *
 * Note pour ui-page-generator : ne pas ré-introduire un landing ici. Si une
 * app métier veut une vraie home avec dashboard agrégé, créer une route
 * dédiée (`/home`, `/overview`…) et mettre à jour ce redirect en conséquence.
 */
export default function HomePage(): never {
  redirect("/runs");
}
