# Registre Crypto

Suivi personnel d'un portefeuille crypto et du marché, en un seul composant React (`RegistreCrypto.jsx`), avec graphiques Recharts et cours de l'API publique CoinGecko.

## Fichiers

| Fichier | Rôle |
|---|---|
| `RegistreCrypto.jsx` | Le composant (export par défaut). Seules dépendances : `react` et `recharts`. |
| `index.html` | Page autonome générée : React, ReactDOM et Recharts chargés depuis jsDelivr. S'ouvre directement dans un navigateur. |
| `build.mjs` | Régénère `index.html` à partir du composant (`npm install && npm run build`). |

## Utilisation et cours réels

- **Cours réels** : ouvrir `index.html` hors d'un artifact, puis toucher « Synchroniser ». Trois façons d'ouvrir la page :
  - le site Vercel du dépôt : `https://rabbijacob.vercel.app/registre/` une fois la branche fusionnée dans `main`, ou l'aperçu Vercel de la branche avant la fusion ;
  - GitHub Pages, activé sur le dépôt : `…github.io/RABBIJACOB/registre/` après la fusion ;
  - un double-clic sur le fichier téléchargé.
- **En artifact** : coller le contenu de `RegistreCrypto.jsx` dans un artifact React. Les artifacts bloquent en général les appels vers `api.coingecko.com` : l'application passe alors en mode démonstration (bannière violette, cours simulés).

Les données saisies restent en mémoire, sans stockage navigateur. Exportez une sauvegarde JSON (Paramètres → Sauvegarde) avant de fermer la page, puis réimportez-la à la session suivante.

## Méthode de calcul

- **PRU** (prix de revient unitaire) moyen pondéré. Les frais d'achat entrent dans le coût de revient.
- **Vente** : le coût sorti vaut quantité × PRU. La plus-value réalisée est le produit net (quantité × prix − frais) moins ce coût sorti. Le PRU des unités restantes ne change pas.
- **Plus-value latente** : valeur au cours actuel − coût de revient des unités détenues.
- **Ordre d'imputation** : par date, les achats avant les ventes le même jour, puis dans l'ordre de saisie. Une vente supérieure au solde détenu à sa date est refusée, que ce soit à la saisie, à l'import, à la modification ou à la suppression.
- **Devises** : un montant saisi dans une autre devise que la devise d'affichage est converti au taux du jour CoinGecko (`/exchange_rates`).

Ces calculs servent au suivi. Ils ne reproduisent pas la méthode fiscale française de calcul des plus-values sur actifs numériques (article 150 VH bis du CGI).

## Score d'opportunité (0 à 100)

Le score est un indicateur technique descriptif. Il résume la position du cours actuel par rapport à son historique, sans rien prédire. Il vient de la même requête CoinGecko que la liste de marché, donc sans appel supplémentaire. Chaque mesure est ramenée linéairement sur 100 points, puis pondérée :

Deux pondérations : une pour le bitcoin, une pour les altcoins. Pour un altcoin, une forte décote est souvent celle d'un projet en déclin : la décote pèse moins, et une mesure de force relative face au bitcoin prend le relais.

| Mesure | Poids bitcoin | Poids altcoin | 0 point | 100 points |
|---|---|---|---|---|
| Décote sous le plus haut historique | 30 % | 15 % | au plus haut | −80 % ou plus bas |
| Repli sur 30 jours | 25 % | 20 % | +20 % ou plus | −30 % ou plus |
| Tendance de fond sur 200 jours | 20 % | 15 % | −50 % ou moins | +50 % ou plus |
| RSI 14 sur bougies de 4 h (7 derniers jours) | 25 % | 20 % | RSI ≥ 70 | RSI ≤ 30 |
| Force relative face au bitcoin | — | 30 % | 50 % de moins bien que le bitcoin sur 200 j (20 % sur 30 j) | 50 % de mieux sur 200 j (20 % sur 30 j) |

La force relative compare la variation de l'actif à celle du bitcoin sur la même période, en faisant la moyenne de l'échelle 200 jours et de l'échelle 30 jours. Elle n'ajoute aucune requête : le bitcoin figure déjà dans la liste.

Si une mesure manque (actif récent), les poids sont renormalisés. Il faut au moins trois mesures pour obtenir un score. Les stablecoins ne sont pas notés. Les tranches affichées sont : faible (< 40), moyen (40–59), élevé (60–79) et très élevé (≥ 80). Le détail de chaque mesure est visible dans la fiche de l'actif : touchez son nom ou son score.

Le sentiment global du marché (indice Fear & Greed, alternative.me) s'affiche au-dessus de la liste, à titre de contexte. Il n'entre pas dans le score.

## Seuils clés

La fiche d'un actif calcule, sur un an de clôtures journalières (une requête à l'ouverture de la fiche, réutilisée ensuite pendant 6 h) :

- les moyennes mobiles à 50 et 200 jours ;
- les plus hauts et plus bas sur 30 jours, 90 jours et 52 semaines, ainsi que le plus haut historique ;
- les supports et résistances. Ce sont des pivots, c'est-à-dire des extrêmes locaux sur ±5 jours, regroupés à 2,5 % près. Une zone n'est retenue que si le cours l'a touchée au moins deux fois. La fiche affiche les deux supports les plus proches sous le cours et les deux résistances les plus proches au-dessus.

Les seuils sont classés du plus haut au plus bas, avec le cours actuel intercalé et l'écart en %. La cloche d'un seuil crée l'alerte correspondante en un clic : « au-dessus » si le seuil est au-dessus du cours, « en dessous » sinon.

## Format CSV

Séparateur `;` (la `,` et la tabulation sont aussi détectées). Décimales à virgule ou à point. Dates JJ/MM/AAAA ou AAAA-MM-JJ. Fichier UTF-8 avec BOM à l'export.

```
date;type;actif_id;symbole;nom;quantite;prix_unitaire;frais;devise;note
15/01/2025;achat;bitcoin;BTC;Bitcoin;0,05;92500;4,5;EUR;Achat mensuel
```

`actif_id` est l'identifiant CoinGecko (`bitcoin`, `ethereum`, `avalanche-2`…). À défaut, le symbole est rapproché du top 100. À l'import, les lignes identiques à une transaction existante sont ignorées, et chaque ligne rejetée est signalée avec son numéro et le motif.

## API CoinGecko : synchronisation manuelle

Aucune requête ne part sans action de l'utilisateur : ni à l'ouverture de la page, ni à intervalle régulier, ni au changement de devise.

- **« Synchroniser »** (barre du haut, Paramètres, bannières) déclenche 1 à 3 requêtes CoinGecko : le top 100, les actifs suivis hors du top 100 et les taux de change si un montant est libellé dans une autre devise. Elle charge aussi l'indice Fear & Greed. Les alertes sont vérifiées à chaque synchronisation.
- **Historique** : la courbe de valeur ne se charge qu'après un clic sur « Charger l'évolution » ou sur une période. Elle se recharge ensuite si vous ajoutez une transaction sur un nouvel actif. La fiche d'un actif charge un an d'historique à son ouverture. Les historiques déjà reçus sont réutilisés sans nouvelle requête.
- **Recherche** hors du top 100 : une requête par clic sur « Rechercher sur CoinGecko ».

Les appels passent par une file d'attente unique, espacés d'au moins 1,2 s. Après un échec (HTTP 429, réseau, erreur 5xx), le bouton reste désactivé pendant une pause qui double à chaque échec : 15 s, 30 s, 60 s… jusqu'à 5 min. La pause dure au moins 60 s après un 429. Pendant ce temps, l'application affiche les cours de la dernière synchronisation réussie. Si CoinGecko n'a jamais répondu, elle affiche des cours simulés, signalés comme tels.

Hébergée sur Vercel, la page ne coûte qu'une requête à son ouverture. Les synchronisations partent directement du navigateur vers CoinGecko, sans passer par Vercel.
