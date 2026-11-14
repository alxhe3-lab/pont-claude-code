# Pont Claude Code

**Relie une conversation Claude (app de bureau) à Claude Code sur ton ordinateur. Plus de copier-coller entre les deux.**

*[English below](#english)*

Sans le pont, tu fais la navette à la main : tu demandes un prompt au chat, tu le colles dans Claude Code, tu recopies son rendu dans le chat, et ainsi de suite.

Avec le pont, tout se fait depuis le chat :

1. Le chat rédige un brief complet et lance Claude Code dans le dossier du projet.
2. Il suit l'avancement (fichiers lus, commandes lancées…).
3. Si Claude Code pose une question, **le chat y répond lui-même** quand la réponse est déjà dans la conversation.
4. Tu n'es interrompu **qu'à la fin**, ou si une info ou une décision ne peut venir que de toi.

```
toi ──► chat Claude ──cc_start──► Claude Code (ton Mac/PC, ton projet)
              ▲  ◄──cc_wait── progression, rapport, questions
              └──cc_reply──► réponses, étape suivante (même session)
```

## Prérequis

- L'app **Claude Desktop** (macOS ou Windows).
- **Claude Code** installé et connecté sur le même ordinateur (la commande `claude` marche dans un terminal).

## Installation

1. Télécharge `pont-claude-code.mcpb` (page *Releases*).
2. Double-clique dessus (ou glisse-le dans **Réglages → Extensions** de Claude Desktop), puis clique sur Installer.
3. Choisis éventuellement un dossier de projet par défaut et un mode de permissions.

C'est tout. Dans une conversation, dis par exemple :

> « Dans ~/mon-projet, ajoute une page de connexion avec Claude Code et dis-moi quand c'est fini. »

## Permissions

Ici, Claude Code tourne sans terminal : personne ne peut cliquer sur « Autoriser » en direct. Le réglage **Permission mode** décide donc de ce qu'il fait seul :

| Mode | Ce qu'il fait seul |
|---|---|
| `acceptEdits` (par défaut) | modifie les fichiers ; une commande non autorisée est bloquée et le chat te demande |
| `auto` | Claude Code juge lui-même ce qui est sûr (si ton compte y a accès) |
| `manual` | rien sans accord : tout ce qui est bloqué remonte au chat |
| `dontAsk` | uniquement les outils listés dans *Extra allowed tools* |
| `plan` | lit et propose un plan, ne modifie rien |
| `bypassPermissions` | tout, sans aucun contrôle ; refusé tant que **Allow bypassPermissions** n'est pas coché |

**Extra allowed tools** autorise des commandes précises, par exemple `Bash(npm:*),Bash(git:*),Bash(node:*)`.

Quand une action est bloquée, la tâche passe en `needs_permission`. Le reste du travail est fait, le chat te dit ce qui a été bloqué, puis relance avec ton accord.

## Les outils (pour le chat)

| Outil | Rôle |
|---|---|
| `cc_start` | lance une tâche (brief, dossier, mode ; `session_id` pour reprendre une session existante, même lancée dans le terminal) |
| `cc_wait` | attend jusqu'à 50 s et renvoie la progression, puis le rapport, les questions ou les actions bloquées. Avec `until_done: true`, attend la fin de l'exécution (jusqu'à `max_minutes`, 60 par défaut, 120 au plus) |
| `cc_reply` | répond ou donne l'étape suivante dans **la même session** Claude Code ; accepte aussi `until_done` et `max_minutes` |
| `cc_stop` | interrompt la tâche et ce qu'elle a lancé (serveur de dev…) ; la session est gardée |
| `cc_list` | tâches récentes (gardées après un redémarrage) et réglages détectés |

Statuts : `running`, `needs_input`, `needs_permission`, `done`, `error`, `stopped`, `interrupted`.

### Attendre jusqu'à la fin (`until_done`)

Pour une tâche de plus d'une minute, le chat appelle `cc_wait` avec `until_done: true`. L'appel reste ouvert jusqu'à ce que la tâche quitte l'état `running` (`done`, `needs_input`, `needs_permission`, `error`, `stopped`, `interrupted`), puis renvoie le résultat habituel. L'app Claude met ces appels longs en arrière-plan et reprend la conversation quand ils se terminent : le chat n'a plus à vérifier toutes les 50 secondes.

- `max_minutes` (60 par défaut, 120 au plus) limite l'attente. Une fois cette durée atteinte, l'outil renvoie `running` avec une note. La tâche continue et un nouveau `cc_wait` reprend l'attente.
- Si le client abandonne l'appel avant la fin (délai dépassé, annulation), la tâche Claude Code **n'est pas interrompue** : elle continue, et le `cc_wait` suivant la retrouve avec toute sa progression.
- Pendant l'attente, le pont envoie une notification de progression toutes les 10 s si le client en demande. Les clients qui remettent leur délai à zéro à chaque notification gardent ainsi l'appel ouvert.
- Sans `until_done`, rien ne change : 50 s au plus.
- `cc_start` n'a pas cette option. Si le client coupait un `cc_start` long, le chat n'aurait pas reçu le `task_id` et pourrait relancer la tâche en double. Le chat lance donc la tâche avec `cc_start`, puis attend avec `cc_wait`.

### Comment ça marche

- Le pont lance `claude -p --output-format stream-json` dans le dossier du projet. Le brief passe par l'entrée standard, donc il n'y a pas de limite de taille, même sous Windows.
- La session reçoit un identifiant fixe (`--session-id`) et chaque réponse la reprend (`--resume`) : Claude Code garde tout le contexte.
- Une consigne ajoutée à Claude Code (`--append-system-prompt-file`) lui dit de travailler seul, de ne pas contourner un refus de permission et, s'il est vraiment bloqué, d'écrire ses questions sur des lignes `BRIDGE_QUESTION:`.
- Le chat ne reçoit qu'un résumé compact : les étapes (fichiers, commandes), puis le rapport final. Les messages des sous-agents et les doublons sont filtrés.
- Les tâches sont enregistrées dans `~/.pont-claude-code/tasks.json`. Si tu fermes l'app pendant une tâche, elle passe en `interrupted` et `cc_reply` la reprend.
- Les modes de permission sont lus dans `claude --help`, ce qui suit les versions de Claude Code.

## Développement

```bash
npm install
npm test          # 15 scénarios avec un faux Claude Code (questions, permissions, arrêt, redémarrage, until_done…)
npm run test:real # vérification avec ton vrai Claude Code dans un dossier jetable (consomme un peu de quota)
npm run pack      # fabrique pont-claude-code.mcpb
```

Pour l'utiliser sans .mcpb, ajoute ceci à `claude_desktop_config.json` :

```json
{ "mcpServers": { "pont-claude-code": {
  "command": "node", "args": ["/chemin/vers/pont-claude-code/server/index.js"],
  "env": { "PONT_DEFAULT_CWD": "~/projets", "PONT_PERMISSION_MODE": "acceptEdits" }
} } }
```

Variables : `PONT_DEFAULT_CWD`, `PONT_PERMISSION_MODE`, `PONT_ALLOWED_TOOLS`, `PONT_ALLOW_BYPASS`, `PONT_MODEL`, `CLAUDE_BIN`, `PONT_STATE_DIR`.

## Limites connues

- Avec `until_done`, un seul appel suffit jusqu'à 2 h. Au-delà, ou si le client n'accepte pas les appels longs (erreur de délai dépassé), le chat refait des appels `cc_wait` ; la tâche n'est jamais interrompue par ces coupures. Sans `until_done`, chaque appel dure au plus 50 s.
- Si le client coupe un appel long sans prévenir le pont, quelques lignes de progression peuvent ne pas être renvoyées. Le statut, le rapport, les questions et les actions bloquées reviennent toujours au `cc_wait` suivant.
- Fermer l'app Claude pendant une tâche l'arrête quand même : elle passe en `interrupted` et `cc_reply` la reprend.
- Pour reprendre une session lancée dans le terminal, donne son `session_id` **et le même dossier** : Claude Code range ses sessions par dossier.
- Ne marche qu'avec l'app **de bureau**, parce que Claude Code doit tourner sur ta machine. claude.ai dans le navigateur et le mobile ne voient pas l'extension.
- Testé sur macOS avec Claude Code 2.1.323. Windows est prévu dans le code mais pas encore vérifié sur une vraie machine.
- Projet indépendant, non affilié à Anthropic.

---

## English

**Pont Claude Code** ("Claude Code bridge") lets a conversation in the Claude desktop app hand work to Claude Code on the same computer. The chat starts Claude Code with a full brief, follows its progress, answers Claude Code's questions itself whenever the conversation already holds the answer, and only interrupts you at the end or when it needs something only you know.

**Requirements:** Claude Desktop + Claude Code installed and signed in (`claude` works in a terminal).
**Install:** open `pont-claude-code.mcpb` (or drag it into Settings → Extensions).
**Tools:** `cc_start`, `cc_wait`, `cc_reply`, `cc_stop`, `cc_list`. See the tables above.
**Waiting until the end:** `cc_wait` (and `cc_reply`) accept `until_done: true`. The call stays open until the task leaves `running` (done, needs_input, needs_permission, error, stopped, interrupted) or `max_minutes` is reached (default 60, max 120), then returns the usual result. The Claude app runs long tool calls in the background and wakes the conversation when they finish, so the chat no longer polls every 50 s. Without `until_done`, `cc_wait` still returns within 50 s. If the client drops the call early (timeout, cancel), the Claude Code task is never interrupted: it keeps running and the next `cc_wait` picks it up with all its progress. Progress notifications are sent every 10 s when the client asks for them. `cc_start` doesn't take `until_done`: if a long `cc_start` were cut, the chat wouldn't have the `task_id` and might start the task twice.
**Known limits:** beyond 2 h, or with a client that refuses long calls, the chat calls `cc_wait` again; nothing is lost. If a client drops a long call silently, a few progress lines may be skipped, but the status, report, questions and blocked actions always come back. Closing the Claude app still stops a running task (`interrupted`, resumable with `cc_reply`).
**Permissions:** headless Claude Code can't prompt you, so blocked actions come back as `needs_permission` and the chat asks you. The default is `acceptEdits`; `bypassPermissions` is refused unless you enable it in the settings.
**Robust:** the brief goes through stdin (no size limit), sessions are pinned with `--session-id` and resumed with `--resume`, tasks survive an app restart, stopping a task kills what it launched, and the permission modes are read from your installed `claude --help`.

MIT licence. Independent project, not affiliated with Anthropic.
