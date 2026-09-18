# Organização de demonstração restaurável

A implementação usa os fluxos normais do Studio, o repositório da loja e a interface existente de Reports. Preparação e reset ficam em `/_admin` e no CLI, sem novos controles no board. O [guia operacional](demo-organization.md) descreve a versão entregue e suas limitações. Produção foi consultada em modo somente leitura e não foi alterada.

## O que a pesquisa conseguiu verificar

### Fonte e recorte dos dados reais

Consultei o banco de produção pelo MCP `studio-pg-prd` da instalação global do Claude Code. A conexão confirmou `transaction_read_only = on`. As consultas foram limitadas à org de demo e ao schema necessário; não executei tools do produto nem alterei a automação existente.

A janela histórica principal é **11/09/2026 17:38:52 UTC até 18/09/2026 17:38:52 UTC**, com início inclusivo e fim exclusivo. O retrato do board foi consultado às 17:39:35 UTC de 18/09. Consultas adicionais de configuração e mensagens foram feitas na mesma investigação, sem uma única transação compartilhada entre chamadas MCP. Não é um backup consistente nem uma medição de todas as apresentações.

As [consultas de evidência](demo-organization-production-evidence.sql) identificam as fontes E1–E7 usadas abaixo. Os agregados e as descrições foram sanitizados para este repositório público. Não foram publicados IDs de usuários, cards ou runs, prompts completos, nomes de clientes, repositórios externos ou credenciais. Os fixtures de teste continuam sintéticos; o pacote local preparado usa a loja de demonstração solicitada pelo usuário.

### O reset já existe, mas deixa o estado acumular

Existe uma automação ativa de reset desde agosto, agendada para `0 9 * * *`. Os disparos observados ocorrem às 09:00 UTC, 06:00 em São Paulo. Ela usa um agente para comparar o repositório com um commit de referência, decidir quais diferenças preservar, abrir e mesclar PRs de restauração e ajustar cards. Se não encontrar um PR aberto para a busca, o roteiro pede uma nova execução do agente. **O reset depende das mesmas partes variáveis que a apresentação.**

O prompt contém 28 IDs de cards. Um já não existe e 42 cards não dispensados ficam fora dessa lista, conforme E2. O próprio prompt manda preservar cards extras e não limpar threads, comentários ou PRs adquiridos pelos cards de backlog. Logo, o acúmulo não é apenas uma hipótese de falha do scheduler: o contrato atual de reset permite esse estado.

| Retrato persistido, E1 e E7 | Quantidade |
| --- | --- |
| Cards não dispensados | 69: 44 em triagem, 15 em revisão, 8 concluídos e 2 arquivados |
| Cards dispensados ainda retidos | 137, separados dos 69 acima |
| Chats no histórico da org | 719: 639 concluídos, 77 com status de falha, 2 em execução e 1 aguardando ação |
| Chats ainda marcados em execução | Ambos com último `updated_at` em 05/08; isso é estado antigo, não prova de workers ainda ativos |
| Automações configuradas | Uma, o reset diário; não apareceu uma automação comercial separada |

Em 18/09, o reset chegou ao estado `completed`, mas uma chamada persistida de `TASK_BOARD_ITEM_UPDATE` terminou em `output-error` porque o card referenciado não existia. O agente depois escolheu outro card. Isso confirma que **concluir o job não prova que o cenário corresponde ao manifesto**. O relato final de 16/09 também descreve uma reversão indevida de mudança legítima seguida de correção; esse relato não foi validado contra o Git e não é tratado como prova independente de alteração do repositório.

Também existem scripts locais anteriores de snapshot/reset e edição do diagnóstico. Eles não cobrem integralmente threads, partes modificadas, workers, workspace e preview. Sua presença não prova uso atual; a automação descrita acima foi verificada diretamente no banco.

### O que está demorando na amostra

Cruzei `threads` com `dbos.workflow_status` pelo ID da thread nos workflows `hostedHarnessWorkflow`, sem confundir gate, projector e executor como três execuções diferentes. E3 usa os timestamps do DBOS: espera = início menos criação; execução = conclusão menos início. A janela contém 16 desses workflows, todos `SUCCESS`.

| Tipo de execução | Amostra | Menor duração | Maior duração | Maior espera na fila do executor |
| --- | --- | --- | --- | --- |
| Implementação de tarefa | 5 | 1m09s | 14m33s | 370 ms |
| Revisão | 4 | 1m51s | 5m40s | 281 ms |
| Reset diário | 7 | 3m49s | 31m31s | 755 ms |

Esses tempos incluem o trabalho dentro do executor, não apenas o modelo. O DBOS registra uma step `runHostedHarness` para cada um desses 16 workflows, sem separar preparo de sandbox, modelo e ferramentas nessa tabela. **A fila desse executor não explica os minutos de espera observados; a contribuição exata do cold start ainda não foi medida.** Não usar essa amostra pequena para prometer ausência de congestionamento futuro.

Os 16 chats correspondentes têm uma mensagem de usuário cada. Duas outras threads criadas na janela estão vazias e foram excluídas da contagem de execução. Nenhuma dessas 18 threads estava em `failed` no recorte consultado. Há, porém, 18 partes de ferramenta `output-error` persistidas na janela, distribuídas por sete dos 16 chats executados: seis erros em duas implementações, dez em três revisões e dois em dois resets, conforme E4. Incluem timeouts de testes de navegador, comandos que falharam, ferramenta indisponível e card inexistente. São falhas intermediárias, não 18 demos fracassadas; o status terminal esconde esse atrito.

`threads.updated_at` não serve como duração: houve atualização horas depois do término real. Também não dá para medir primeiro token com `persisted_at`: nessa amostra, a primeira parte de assistente e a parte final de cada chat foram persistidas juntas. O `run_id` pode ser reutilizado em follow-ups; métricas futuras devem usar workflow/fence e instrumentar o primeiro evento recebido pelo cliente.

### Como o uso real muda os roteiros

E5 mostra nove cards criados na janela: dois manuais, seis de diagnóstico e um da automação. Os dois pedidos manuais tratam de **busca mais visível no cabeçalho** e **barra promocional colorida com contagem regressiva**. As outras implementações da amostra vieram de tarefas técnicas do diagnóstico, como metadados e headers. Há 34 eventos retidos de atividade em seis cards, segundo E6; esses eventos não identificam sessões de apresentação ou todos os cliques.

Ler as respostas finais também revelou uma fonte de demo sem resultado visível: uma tarefa de diagnóstico terminou sem alteração nem PR porque, segundo o agente, o problema já estava corrigido. Outra reconheceu que o diagnóstico estava desatualizado e trabalhou em um caso de fallback. Não refiz essas verificações no site real. A evidência é o conteúdo persistido da execução e justifica um requisito do cenário: **diagnóstico, baseline, tarefa, diff e preview precisam pertencer à mesma versão**. Não basta congelar o relatório e continuar alterando o site.

Com esses dados, priorizo busca, promoção visual e diagnóstico até correção. A única automação observada é manutenção, então demonstrar automações comerciais fica opcional. Ajustes por follow-up continuam possíveis em roteiro limitado, mas a amostra recente não os estabelece como uso principal.

A [consulta geral de diagnóstico](demo-organization-audit.sql) continua disponível. Ela foi validada em Postgres 16.14 temporário com as migrations reais e duas orgs sintéticas; a pesquisa de produção usou SELECTs equivalentes e os agregados de evidência via MCP. Dados excluídos não podem ser reconstruídos, atividade pode estar coalescida e os agregados mudam conforme a org continua sendo usada.

### Por que restaurar só o board não resolve

| Fato verificado no código | Consequência para a demo |
| --- | --- |
| [`TASK_BOARD_ITEM_LIST`](../src/tools/task-board/list.ts) chama `recoverStalledTasks` ao abrir o board. | Uma leitura pode disparar recuperação e alterar o cenário. |
| [`attachThreads`](../src/storage/task-board.ts) compõe cards com status, última resposta, mensagens, progresso e custo. | É preciso restaurar o histórico e as relações, além da tarefa. |
| [`enqueueSuperAgentForTask`](../src/tools/task-board/enqueue-super-agent.ts), [`enqueueAgentRunForTask`](../src/tools/task-board/enqueue-task-run.ts) e o [POST de chat](../src/api/routes/decopilot/routes.ts) resolvem quota, plano ou modelos antes do executor. | Mockar a resposta final do modelo ainda permite falha antes de começar. |
| [`prepareRun`](../src/api/routes/decopilot/dispatch-run.ts) resolve contexto e credenciais; [`SandboxDispatchClient`](../src/harnesses/sandbox-dispatch-client.ts) prepara workspace e provisiona sandbox. | O modo demo precisa desviar antes dessas dependências. Aquecer um sandbox sozinho não basta. |
| [`review-sweeper`](../src/tools/task-board/review-sweeper.ts), [`run-reactions`](../src/tools/task-board/run-reactions.ts), [automações de coluna](../src/tools/task-board/run-column-automation.ts) e [arquivamento](../src/tools/task-board/dbos-archive-sweep.ts) continuam trabalhando sem interação humana. | A política demo precisa alcançar leituras e consumidores assíncronos, não apenas o botão de executar. |
| [`prs-get`](../src/tools/task-board/prs-get.ts) busca informações externas mesmo quando existe um link de PR no banco. | Semear uma URL de PR não torna checks, revisão ou preview determinísticos. |
| [`TaskBoardStorage.delete`](../src/storage/task-board.ts) deixa threads vinculadas; cards de reports podem ser apenas dispensados. | Um loop de create/delete de tarefas não é um restaurador completo. |
| [Schedules de automação](../src/automations/dbos-sync.ts) também existem no DBOS. | Excluir triggers no Postgres não cancela, por si só, os schedules. |

## Decisões implementadas

| Decisão | Motivo |
| --- | --- |
| Nova org dedicada, registrada por ID no banco | Permite reset completo sem converter ou apagar a org atual de produção. Renomear o slug não altera o isolamento. |
| Bundle preparado do GitHub da loja | Preserva visual, catálogo, caminhos de arquivos e patches da loja usada pelos vendedores. Elimina a loja fictícia da primeira implementação. |
| Widget original de Reports via MCP local | Mantém a experiência existente. Apenas o provedor de dados é substituído por um diagnóstico salvo; não há página de relatório paralela. |
| Reset exclusivamente no `_admin` ou CLI | Atende à restrição de não acrescentar controles de demo à interface do produto. Ser owner da org não concede acesso ao reset administrativo. |
| Execução roteirizada antes de modelo/sandbox/GitHub | Retira as fontes de espera e erro identificadas na investigação. DBOS e mensagens continuam persistidos. |
| Pacote imutável com commits e data de captura | Permite reproduzir a apresentação e revisar a origem dos artefatos. Outra versão recebe uma nova org de avaliação. |
| Diagnóstico histórico apresentado como histórico | O achado A11Y-028 já está corrigido no commit atual. A tarefa verifica isso e não inventa uma correção inexistente. |
| Reset transacional, geração e idempotência | Impede callbacks antigos ou pedidos concorrentes de estragar o estado restaurado. |
| Sem cron instalado por padrão | Evita restaurar durante uma apresentação. O CLI permite agendamento pelo operador. |

## Evidência adicional usada na correção

A configuração da própria org de produção identifica `deco-sites/demo-storefront` como repositório e `reports.decocms.com` como Reports. O pacote local usa o commit `928488ab20984ee8d586f5c0287585bf129c2154` da loja e o widget no commit `649e4965e133462c5bfd7c1b03c384438a0e62ef` de Reports. Foram capturadas 15 seções do diagnóstico público e 45 assets. Nenhuma credencial da org foi copiada.

Os pedidos de busca visível no header e top-bar com countdown observados no banco originam os dois roteiros de mudança. O terceiro usa o achado de acessibilidade real do Reports. Os dez cards e os chats de execução são preparação editorial para apresentar esses fluxos; não são uma cópia do histórico dos usuários.
