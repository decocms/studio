# Demonstração persistida: operação e roteiro de teste

Esta implementação entrega o primeiro cenário `storefront-v1`: dez tarefas, histórico de chats e comentários, três execuções preparadas e uma loja sintética com preview. A [pesquisa e proposta original](demo-organization-proposal.md) explica a escolha dos roteiros com dados consultados em produção.

## Testar localmente

No ambiente preparado para este PR, abra **http://localhost:4107/demo-local/tasks**. É uma instalação local, com dados em `/tmp/studio-demo-review`, API em 3107 e frontend em 4107. O login local usa a conta do sistema. Esse endereço serve para testar nesta máquina ou compartilhar a tela; não é um endereço público para outras máquinas.

Para reproduzir em outro checkout, após instalar as dependências:

```bash
# Terminal 1: banco e NATS locais, migrations, API e frontend.
DATABASE_URL='' NATS_URL='' S3_ENDPOINT='' SKIP_MINIO=true \
  bun run dev --home /tmp/studio-demo-review --port 3107 \
  --vite-port 4107 --base-url http://localhost:4107 --no-tui

# Terminal 2, depois de o servidor iniciar:
bun run demo:setup --home /tmp/studio-demo-review \
  --org demo-local --url http://localhost:4107
```

`demo:setup` pode ser repetido: não restaura uma demo que já foi inicializada. Se houver mais de um usuário, passe `--owner EMAIL` de um membro existente. Em um deployment com autenticação normal, faça login primeiro; para desenvolvimento com esse modo, acrescente `--no-local-mode` ao comando do servidor.

Roteiro para vendedor e designer:

1. Clique em **Prepare demonstration / Preparar demonstração** e confirme a restauração. O board fica com dez cards, sem trabalho em execução.
2. Use **Start presentation / Iniciar apresentação** para reservar as mutações por 90 minutos. Outros membros continuam podendo visualizar.
3. Passe o mouse sobre o card **Make product search visible in the header** e clique em **Run**. A execução tem três etapas, separadas por 1,8 segundo; não inicia modelo, VM, build ou GitHub.
4. Abra o card e seu chat para ler a execução. Abra **Open preview**, busque `vase`, navegue por teclado e abra um produto. **Compare before** mostra a baseline.
5. Clique em **Ship to production** no card. Aqui a ação publica apenas na **Published demo store / Loja publicada da demo**, sem deploy externo. Busca, promoção e metadados aprovados são acumulados nessa loja.
6. Repita com a barra promocional e a correção do diagnóstico. **Add scenario task** cria outro card explicitamente associado ao roteiro escolhido.
7. Faça refresh: alterações, comentários e resultados permanecem. Prepare a demonstração novamente para voltar ao início. Finalize a reserva ao terminar.

## Qual org é demo neste deployment?

O cadastro fica no banco, em `demo_organizations`, por **ID da organização**. O slug é usado pelo CLI para selecionar ou criar a org; renomeá-lo não altera a identidade da demo. Não há lista de slugs em env var nem código especial para `demo-storefront`.

```bash
# Usando o DATABASE_URL já configurado para o deployment:
bun run demo:setup --org sales-demo --owner presenter@example.com \
  --url https://studio.example.com
```

O CLI é uma operação de administrador com acesso ao banco. Ele recusa converter uma org com tarefas, chats, repositórios ou automações existentes. Para a avaliação, crie uma org nova; a conversão da atual `demo-storefront` fica separada.

O cadastro também habilita `organization_settings.flags.demo_mode_enabled`, configura as lanes e desabilita revisores automáticos e auto-merge. A flag pode suspender mutações, mas **removê-la não converte a org para execução real**: o cadastro persistido continua bloqueando integrações, agentes e sandboxes. A API de produto não permite criar ou remover esse cadastro.

## Restaurar e operar

O botão usa `DEMO_RESET { idempotencyKey, expectedGeneration }`. Reset e mutações usam o mesmo lock transacional por org. A restauração substitui tarefas, chats e dependências, cria IDs novos e incrementa a geração; preserva login, membros e configurações da organização. Falha na transação conserva o estado anterior. Repetir a mesma chave não limpa a org novamente.

O CLI usa a mesma operação de storage:

```bash
bun run demo:reset --home /tmp/studio-demo-review --org demo-local \
  --url http://localhost:4107
```

É possível chamar esse comando pelo cron do deployment, com `--owner EMAIL` quando necessário. **Não foi instalado um reset nightly automático.** Uma reserva de outro apresentador impede o reset. Para cron, use uma conta operacional distinta dos apresentadores. O CLI escreve diretamente no banco: uma aba já aberta deve ser recarregada após esse reset administrativo. O botão emite SSE e atualiza as abas abertas.

As execuções usam DBOS e partes de mensagens persistidas, sem fila de agentes. Cada etapa confere execução e geração dentro do lock. Callbacks de uma geração apagada não recriam dados. Um reconciliador por minuto recupera admissões persistidas antes de uma queda; um workflow que terminou com erro é marcado como interrompido e o card volta a permitir execução. API, Postgres e DBOS continuam sendo dependências reais: não há promessa de disponibilidade absoluta durante uma queda desses serviços.

## Escopo e decisões da implementação

| Decisão | Motivo |
| --- | --- |
| Nova org dedicada, sem alterar produção | Permite avaliar e restaurar tudo da demo sem misturar trabalho real ou executar migração destrutiva. |
| Cadastro por ID no banco + flag de suspensão | Configuração acompanha o deployment e não permite fallback acidental para execução real. |
| Dez cards; busca, promoção e diagnóstico | A pesquisa real identificou esses pedidos. O número de cards é uma escolha de apresentação. |
| Preview e diff servidos pela própria API | Remove dependência de sandbox, build e serviço de deploy. Os artefatos exigem acesso à org. |
| Publicação simulada explícita | Mostra a aprovação e seu resultado mantendo o fluxo isolado de GitHub e hosting. |
| Reset em uma transação | O cenário não possui agentes externos a drenar; não precisa de uma máquina de estados de reset distribuída. |
| Reserva de 90 minutos | Evita dois vendedores alterarem a mesma apresentação; expira sem depender de um processo em memória. |
| Ações fora do roteiro recusadas | Um card arbitrário não dispara agente real. Follow-up por chat aceita apenas `Run this scenario again` ou `Execute este roteiro novamente`. |
| Diagnóstico em página curada própria | Mantém relatório e baseline coerentes, sem chamar o serviço de Reports. A tela completa de Reports não está simulada. |
| Agenda de automações fica fora desta primeira versão | Há cards a executar, mas não automações comerciais nem schedules fictícios. Na amostra, a automação observada era manutenção. |

As proteções cobrem a admissão de ferramentas, mensagens, execução de agentes, sandbox, clientes MCP e os reconcilers de tarefas. E-mails de digest excluem orgs cadastradas. Eventos de analytics da interface ainda seguem a instrumentação normal; filtrar essas orgs nos relatórios de produto é necessário.

## Validação

`packages/e2e/tests/demo-organization.spec.ts` usa autenticação, Postgres, API, DBOS e navegador reais. Cobre execução sem credenciais de modelo, persistência, preview interativo, publicação dos três roteiros, cancelamento, reserva, reset concorrente e idempotente, isolamento entre orgs, referência antiga após reset e bloqueio quando a flag é removida.

```bash
PORT=3108 VITE_PORT=4108 BASE_URL=http://localhost:4108 \
  DATA_DIR=/tmp/studio-demo-e2e \
  bun run --cwd packages/e2e test:e2e tests/demo-organization.spec.ts \
  --workers=1 --reporter=list
```

Use um servidor separado com `--no-local-mode` para essa suíte. Os comandos e os resultados finais de qualidade estão no PR.
