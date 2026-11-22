# Journal des changements

## 0.4.0 — 20/11/2026

Après la nuit du 19 au 20/11 : toutes les tâches s'étaient arrêtées vers 2 h sur « You've hit your 5-hour limit · resets 3:10am (Europe/Bucharest) » et n'avaient été relancées qu'à 11 h 45.

- **Reprise automatique après une limite d'usage.** Un run qui se termine sur une limite d'usage (texte « hit your … limit », « usage limit », « resets <heure> (<fuseau>) », ou ligne de progression « usage limit: rejected ») met la tâche dans le nouveau statut `waiting_limit`, avec `resume_at`. L'heure est lue avec son fuseau (aujourd'hui, ou demain si elle est passée de plus de 15 min) ; sinon le champ `resetsAt` de Claude Code ; sinon nouvel essai dans 30 min. À `resume_at` + 2 min, la même session est relancée comme par `cc_reply`, dans le même mode de permission (revérifié : un mode que les réglages n'autorisent plus n'est jamais utilisé), avec un message réglable. Reprises espacées de 20 s, 6 au plus par tâche, chacune notée dans l'historique (« reprise automatique n°k à HH:MM »). Les tâches en attente restent dans `tasks.json`, sont réarmées au démarrage (celles qui sont dues reprennent tout de suite) et sont vérifiées toutes les 60 s d'après l'heure réelle, ce qui rattrape une veille. `cc_stop` annule une reprise prévue. Nouveaux réglages : *Reprendre automatiquement après la limite d'usage* (activé) et *Automatic resume message*.
- **Mac gardé éveillé** : `caffeinate -i -w <pid de l'extension>` tant qu'une tâche tourne ou attend sa limite, arrêté quand plus rien ne tourne. Réglage *Keep the Mac awake while working* (activé). Capot fermé sur batterie, macOS dort quand même : le README le dit.
- **`cc_list`** avertit « mode par défaut dangereux, préférez acceptEdits » si le mode par défaut est `bypassPermissions`, et montre `resume_at`, les reprises faites, l'état de la reprise automatique et de `caffeinate`.
- `tasks.json` est copié une fois dans `tasks.before-0.4.0.json` au premier démarrage de la 0.4.0.
- `npm run pack` fabrique `pont-claude-code-<version>.mcpb` (n'écrase plus les paquets précédents).
- Code : `server/autoresume.js` (lecture des messages de limite, planificateur, `caffeinate`), testé sur une horloge simulée (`test/unit.mjs`) ; nouveaux scénarios dans `test/e2e.mjs` avec un faux `caffeinate` (`test/fake-caffeinate.mjs`).

## 0.3.1 — 17/11/2026

Décisions du mainteneur du 16/11/2026.

- **Réglage « Permission mode » mal tapé** : si la valeur n'est pas exactement un mode mais contient le nom d'un seul mode (par exemple « Allow bypassPermissions »), ce mode est utilisé au lieu de retomber sur `acceptEdits`. Le nom est cherché comme un mot entier, sans tenir compte des majuscules (« automatically » ne compte pas comme `auto`). bypassPermissions reste refusé tant que *Allow bypassPermissions* n'est pas coché. Si la valeur contient plusieurs modes ou aucun, rien ne change (`acceptEdits`). Dans tous ces cas, un avertissement est écrit dans le journal et dans `cc_list`.
- **Limite de sécurité de `until_done`** : `cc_wait` et `cc_reply` avec `until_done: true` rendent la main d'eux-mêmes au bout de 70 s avec le statut `running` et une note, avant qu'une session distante coupe l'appel (vers 80 s). La tâche n'est pas interrompue. Cette limite se règle avec le nouveau réglage *until_done safety limit (seconds)* (`PONT_UNTIL_DONE_SAFETY_S`) ou, appel par appel, avec le paramètre `safety_seconds`. La valeur par défaut est 70 et `0` désactive la limite (attente jusqu'à `max_minutes`, comme en 0.3.0).
- **`tasks.json` limité à 50 tâches** : le fichier ne garde que les 50 tâches les plus récentes. Les plus anciennes ne sont pas supprimées : elles sont déplacées telles quelles à la fin de `tasks-archive.json`, dans le même dossier, sans doublon. Si l'archive est illisible, elle n'est jamais écrasée et rien n'est retiré de `tasks.json`. Avant sa première écriture, la 0.3.1 copie `tasks.json` dans `tasks.before-0.3.1.json` (une seule fois). Une tâche relancée avec `cc_reply` redevient récente : en 0.3.0, une tâche ancienne relancée pouvait ne plus être enregistrée.
- Code : les fonctions testables sont dans `server/lib.js`, avec des tests unitaires dans `test/unit.mjs`. Ajout de `npm run typecheck` (TypeScript en mode vérification du JavaScript, en dépendance de développement). `npm test` lance maintenant les tests unitaires, les scénarios sur le source, la construction, puis les scénarios sur le paquet construit.

## 0.3.0

- `until_done` et `max_minutes` pour `cc_wait` et `cc_reply`, notifications de progression pendant l'attente.
