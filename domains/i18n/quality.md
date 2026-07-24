# pt-br translation quality

The anti-slop guide. A translation is wrong when it reads like machine output —
grammatically fine, humanly off.

**Enforceable = the three tables (bad-example patterns), the do-not-translate
term list, the generalization stated in parentheses under a table (e.g. any
pt-br value opening with "Por favor"), and every bullet under Mechanics.**
All other prose is guidance for authoring new values — never grounds to
rewrite an existing one.

## Tone

Informal-professional, always "você" (never "tu", never "o usuário" as address).
Short and direct — Portuguese tends to inflate; resist it.

| en | good pt-br | bad pt-br (slop) |
| -- | ---------- | ---------------- |
| Are you sure? | Tem certeza? | Você está certo disso? |
| Something went wrong | Algo deu errado | Alguma coisa ocorreu de forma errada |
| No results found | Nenhum resultado | Não foram encontrados resultados |
| Get started | Começar | Iniciar a utilização |

(Enforceable generalizations of this table: addressing the user as "tu" or
"o usuário"; impersonal-passive openings like "Não foram encontrados…".
"Could be shorter" alone is never a violation.)

## Technical terms stay in English

Do NOT translate: deploy, commit, branch, pull request, PR, merge, webhook,
token, prompt, sandbox, log, trace, build, rollback, feature flag, endpoint.
They are the vocabulary of the audience.

| en | good pt-br | bad pt-br (slop) |
| -- | ---------- | ---------------- |
| Deploy failed | O deploy falhou | A implantação falhou |
| Copy token | Copiar token | Copiar ficha |
| View logs | Ver logs | Visualizar registros |

Words with natural, established Portuguese: connection → conexão,
settings → configurações, organization → organização, member → membro,
permission → permissão. When unsure, keep English.

## No literal calques

Don't transplant English structure word-by-word.

| en | good pt-br | bad pt-br (slop) |
| -- | ---------- | ---------------- |
| You're all set! | Tudo pronto! | Você está todo configurado! |
| Successfully deleted | Excluído | Deletado com sucesso |
| Please try again later | Tente novamente mais tarde | Por favor, tente novamente mais tarde |

("Por favor" opening a sentence is the single most common calque — drop it;
imperative Portuguese is already polite in UI. Likewise: a "… com sucesso"
tail — drop it, the verb alone suffices.)

## Mechanics

- Placeholders verbatim: never translate a placeholder; never reference one
  absent from the en value. Dropping one is allowed only when it has no
  Portuguese function (e.g. an English-only `{plural}` suffix) — the parity
  test is the arbiter.
- The user-facing noun for a thread is **chat** in pt-br too ("Novo chat",
  never "Nova conversa" or "Novo tópico") — consistency with the en UI.
- Capitalization follows Portuguese rules, not English Title Case:
  "Criar conexão", never "Criar Conexão".
- Language labels stay in their own language: "English",
  "Português (Brasil)".
