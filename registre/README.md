# Registre Crypto

Suivi personnel d'un portefeuille crypto et du marché, en un seul composant React (`RegistreCrypto.jsx`), avec graphiques Recharts et cours de l'API publique CoinGecko.

## Fichiers

| Fichier | Rôle |
|---|---|
| `RegistreCrypto.jsx` | Le composant (export par défaut). Seules dépendances : `react` et `recharts`. |
| `index.html` | Page autonome générée : React, ReactDOM et Recharts chargés depuis jsDelivr. S'ouvre directement dans un navigateur. |
| `build.mjs` | Régénère `index.html` à partir du composant (`npm install && npm run build`). |

## Utilisation

- **En artifact** : coller le contenu de `RegistreCrypto.jsx` dans un artifact React. Si l'environnement bloque les appels réseau vers `api.coingecko.com`, l'application passe en mode démonstration (bannière violette, cours simulés).
- **En direct** : ouvrir `index.html` (double-clic, serveur local ou GitHub Pages). Les cours sont réels et se rafraîchissent toutes les 60 secondes.

Les données saisies restent en mémoire, sans stockage navigateur. Exportez une sauvegarde JSON (Paramètres → Sauvegarde) avant de fermer la page, puis réimportez-la à la session suivante.

## Méthode de calcul

- **PRU** (prix de revient unitaire) moyen pondéré. Les frais d'achat entrent dans le coût de revient.
- **Vente** : le coût sorti vaut quantité × PRU. La plus-value réalisée est le produit net (quantité × prix − frais) moins ce coût sorti. Le PRU des unités restantes ne change pas.
- **Plus-value latente** : valeur au cours actuel − coût de revient des unités détenues.
- **Ordre d'imputation** : par date, les achats avant les ventes le même jour, puis dans l'ordre de saisie. Une vente supérieure au solde détenu à sa date est refusée, que ce soit à la saisie, à l'import, à la modification ou à la suppression.
- **Devises** : un montant saisi dans une autre devise que la devise d'affichage est converti au taux du jour CoinGecko (`/exchange_rates`).

Ces calculs servent au suivi. Ils ne reproduisent pas la méthode fiscale française de calcul des plus-values sur actifs numériques (article 150 VH bis du CGI).

## Format CSV

Séparateur `;` (la `,` et la tabulation sont aussi détectées). Décimales à virgule ou à point. Dates JJ/MM/AAAA ou AAAA-MM-JJ. Fichier UTF-8 avec BOM à l'export.

```
date;type;actif_id;symbole;nom;quantite;prix_unitaire;frais;devise;note
15/01/2025;achat;bitcoin;BTC;Bitcoin;0,05;92500;4,5;EUR;Achat mensuel
```

`actif_id` est l'identifiant CoinGecko (`bitcoin`, `ethereum`, `avalanche-2`…). À défaut, le symbole est rapproché du top 100. À l'import, les lignes identiques à une transaction existante sont ignorées, et chaque ligne rejetée est signalée avec son numéro et le motif.

## API CoinGecko

Les appels passent par une file d'attente unique, espacés d'au moins 1,2 s, avec un cache mémoire. Après un échec (HTTP 429, réseau, erreur 5xx), plus aucun appel n'est fait pendant une pause qui double à chaque échec : 15 s, 30 s, 60 s… jusqu'à 5 min. La pause dure au moins 60 s après un 429. Pendant ce temps, l'application affiche les dernières données reçues. Si CoinGecko n'a jamais répondu, elle affiche des cours simulés, signalés comme tels. L'historique de la courbe de valeur est mis en cache 15 min (7 et 30 jours) ou 1 h (90 jours et 1 an).
