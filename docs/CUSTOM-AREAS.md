# Custom focus areas

Agent Monitor's built-in areas describe general engineering qualities: security, performance, testing and so on. A project often has work that matters more specifically: a checkout flow, a search service, a billing API, a design system, a data pipeline, or domain work such as ledger integrity or device firmware. A **custom focus area** lets Focus track that work, score it like a built-in area, and send it through **Focus here**.

This guide is both documentation and the instructions an agent follows when it drafts an area. Agent Monitor copies it into `.agent-monitor/GUIDE.md` when you choose **Start now** under **Create your own Focus Area**. The example below is a payments ledger; the same method works for any feature, service, integration, workflow or standard.

## How Focus observes work

Focus sees only what an agent's tools touch, never code bodies, prompts or tool output:

- **Paths** that tools read or change, relative to the workspace, such as `src/ledger/postEntry.ts`.
- **Recognised commands**, such as `npm run test:ledger` or `make reconcile`, and the files they name.

Each observation is matched against every area. A match has a confidence from 0 to 1 and a reason, such as “ledger” in path. Changes and checks count more than reads, evidence builds up as the chat keeps working in the area and fades only slowly as it works elsewhere, and a command listed by an area is direct evidence for it. A custom area counts an observation when its confidence reaches **0.5**.

## The definition file

Areas live in `.agent-monitor/focus.json` at the workspace root. It is plain JSON, can be committed so a team shares it, and takes effect only after someone enables that exact content in Agent Monitor.

```json
{
  "version": 1,
  "stakes": "production",
  "areas": [
    {
      "id": "ledger-integrity",
      "label": "Ledger integrity",
      "description": "Double-entry balances, reconciliation and settlement stay correct.",
      "signals": {
        "paths": ["src/ledger/**", "db/migrations/*ledger*", "**/reconciliation/**"],
        "terms": [
          "ledger:0.9",
          "journal entry",
          "reconciliation",
          "settlement",
          "double entry:0.9"
        ],
        "files": ["chart-of-accounts.yml"],
        "commands": ["test:ledger", "reconcile-check"],
        "unless": { "journal": ["systemd", "logs"] }
      },
      "examples": {
        "match": [
          "src/ledger/postEntry.ts",
          "db/migrations/20260901_ledger_accounts.sql",
          "tests/reconciliation/daily.test.ts"
        ],
        "ignore": ["src/logging/journal.ts", "src/components/Button.tsx", "docs/README.md"]
      }
    }
  ]
}
```

| Field              | Rule                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | Always `1`.                                                                                                                                                                                              |
| `stakes`           | Optional project default: `standard`, `production` or `critical`. A person's choice in the editor takes precedence.                                                                                      |
| `areas`            | Up to 8 areas.                                                                                                                                                                                           |
| `id`               | 2–32 lower-case letters, digits and hyphens, starting with a letter. Not a built-in area id.                                                                                                             |
| `label`            | 2–32 characters. Not the same as a built-in label; name what is specific to this project.                                                                                                                |
| `description`      | One plain sentence of 10–160 characters describing the work. It is shown on the tile and quoted in Focus here requests, so describe the work; do not address or instruct an agent.                       |
| `signals.paths`    | Up to 32 globs relative to the workspace. `**` matches any folders, `*` any characters in one name, `?` one character. Each needs a real folder or file word; `**/*.ts` is rejected. Default weight 0.9. |
| `signals.terms`    | Up to 80 lower-case words or phrases of up to four words, matched against path words (camelCase and separators are split). Default weight 0.75. Words found in almost every project are rejected.        |
| `signals.files`    | Up to 16 exact file names (no folders). Default weight 0.85.                                                                                                                                             |
| `signals.commands` | Up to 16 script or task names that check this area, such as `test:ledger`. Running one is direct evidence. Generic names such as `test` or `lint` are rejected.                                          |
| `signals.unless`   | Maps a term to up to 12 words that veto it when they appear in the same path, such as `"journal": ["systemd"]`.                                                                                          |
| `examples.match`   | 3–24 workspace paths that must match (confidence at least 0.5).                                                                                                                                          |
| `examples.ignore`  | 3–24 workspace paths that must not match (confidence below 0.4). Choose near misses.                                                                                                                     |
| Weights            | Optional suffix `:0.3`–`:0.95`, such as `"ledger:0.9"`. Distinct matches combine, capped at 0.9.                                                                                                         |

## Method for drafting an area

1. **Understand the request.** Note the area name, what it covers, the industry and the project's stakes.
2. **Inspect the repository.** List its folders and find where this work actually lives: modules, services, migrations, jobs, schemas, tests, configuration, documentation. Use the names this repository uses, not generic industry vocabulary.
3. **Prefer paths.** Write globs for the folders and files that hold this work. Paths are the strongest and most precise signal.
4. **Add terms** for words that appear in this work's file and folder names elsewhere in the repository. Give distinctive words higher weights and ambiguous words lower weights with `unless` vetoes.
5. **Add commands** that run this area's own checks, if the repository has them (package scripts, Make or task targets).
6. **Write examples from real files.** `match`: files that are this work. `ignore`: nearby files that are not, especially ones sharing a word (a `journal` logger for a ledger area).
7. **Validate.** Run the check command you were given, such as `node "<path>/profile.js" check .agent-monitor/focus.json`. Fix every problem it reports and run it again until every area is ready.
8. **Keep what exists.** If the file already has areas, keep them unless asked otherwise. Change no other files.
9. **Report** the paths, terms, commands and examples you chose and why, and anything you were unsure about.

## Quality bar

The check enforces these; aim beyond them:

- **All examples pass.** Positive examples match and near misses are ignored.
- **Narrow.** The check measures how many common project files the area would claim. Above 8% is a warning and above 20% fails. A good project-specific area claims almost none.
- **One area, one concern** a developer would ask an agent to focus on. Split broad topics.
- **Not a duplicate.** If a built-in area already covers it (Security, Performance, Testing and others), refine that work instead.
- **No secrets or personal data** in the file. It is often committed.

Avoid: extension-only globs, generic words such as `service`, `utils` or `data`, terms taken from prose rather than this repository's names, and descriptions that give an agent instructions.

## Stakes

Stakes tell Focus how closely to watch a project. They add vocabulary and markers; they never raise scores on their own.

| Stakes         | For                                                                                                   | Adds                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standard**   | Prototypes, internal tools, personal projects                                                         | Built-in vocabulary only.                                                                                                                                                                                                                                                                            |
| **Production** | Software that real users, money or data depend on                                                     | Release-safety and integrity vocabulary (ledgers, reconciliation, rollbacks, tenant isolation). Marks changes to migrations, authentication and access control, secrets, deployment configuration and payments as sensitive.                                                                         |
| **Critical**   | Infrastructure, safety, health, finance and other regulated systems where failure causes serious harm | Also safety, industrial-control, healthcare-data, regulatory and formal-verification vocabulary, with safety logic counting as Reliability. Also marks changes to cryptography, safety and control logic, concurrency, audit logging, retention and deletion, dependencies and the release pipeline. |

A **sensitive change** marker means an agent changed a workspace file of that kind. It needs strong evidence from the file's own folder or file name, and it is never set for tests, documentation or reads. It does not mean the change is wrong. Focus here requests tell the agent the project's stakes; at Critical, the agent is asked to prefer small, reversible changes and to name evidence and residual risk.

## Trust and privacy

- The definition is data: words, globs and names. There is no code and no regular expressions, and every list is bounded.
- A definition from a cloned repository does nothing until someone enables it. Enabling applies only to that exact content; any edit needs review again.
- Enabled definitions are copied into Agent Monitor's local cache for its hooks. Hooks never read workspace files.
- Area descriptions are quoted in Focus here requests as the user's own definition. The check rejects descriptions that address an agent.
