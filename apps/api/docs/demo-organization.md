# Demonstração persistida: operação e roteiro

A org usa o board, os chats, os controles de revisão e a interface de Reports existentes. Não há barra, badge ou botão de demo no produto. A restauração fica em **`/_admin/orgs` → Demonstration**, protegida pelo administrador do deployment, ou no CLI.

O pacote preparado contém o HTML capturado do repositório da loja, imagens locais, patches de busca e promoção, o diagnóstico público salvo e o build original do widget de Reports. A execução dos agentes é roteirizada; navegação no Studio, permissões, persistência, SSE e DBOS são reais. Refresh conserva alterações.

## Ambiente deste PR

- Board: **http://localhost:4107/demo-storefront/tasks**.
- Reports: abra **Report Agent → Report** na navegação existente.
- Reset: **http://localhost:4107/_admin/orgs**, filtre `demo-storefront` e abra **Demonstration**.
- Dados locais: `/tmp/studio-demo-review`. O login local usa a conta do sistema, habilitada como administradora apenas nessa instância.

Esses endereços funcionam nesta máquina; não constituem um deployment público para participantes remotos. Produção não foi alterada.

A configuração consultada em produção aponta para `deco-sites/demo-storefront` e `reports.decocms.com`. O ambiente preparado usa a loja no commit `928488ab20984ee8d586f5c0287585bf129c2154`, o Reports no commit `649e4965e133462c5bfd7c1b03c384438a0e62ef` e o diagnóstico público de `demo-storefront.decocms.com` capturado em 18/09/2026. O pacote completo fica fora do Git; os fixtures de teste são sintéticos.

## Roteiro para vendedor e designer

1. O administrador restaura o cenário em `/_admin`. O board recebe dez cards, históricos e nenhum trabalho em execução.
2. Na interface normal, execute **Make product search visible in the header**. São três etapas persistidas, separadas por 1,8 segundo, sem modelo, build, GitHub ou sandbox.
3. Abra o card, seu chat e **Open preview**. A loja é a do repositório; busque `sticker` para ver os nomes do catálogo capturado. O link de PR abre o patch preparado contra o commit registrado.
4. Use **Ship to production**. A aprovação altera somente a versão publicada local, disponível em `/api/demo-storefront/demo/storefront`. Nenhum PR ou deploy real é criado.
5. Repita com a barra promocional. Pelo **New task** já existente, um pedido sobre busca ou top-bar também pode usar esses roteiros.
6. Abra **Report Agent → Report**. O widget original apresenta as 15 seções do diagnóstico salvo. Reexecutar o diagnóstico retorna esse mesmo resultado, sem scan externo.
7. O card **Verify the report's cart accessibility finding** demonstra a revisão de um achado real, A11Y-028. O commit capturado já corrigiu o checkbox; o resultado explica que o relatório antecede a correção, sem inventar uma mudança adicional.
8. Refresh preserva tarefas e resultados. O administrador restaura novamente quando quiser encerrar a apresentação.

## Escolher a org e importar o pacote

A identidade da demo fica em `demo_organizations`, por **ID da organização**. `--org` seleciona o slug no CLI; não há env var com uma lista de orgs nem tratamento especial para um slug específico. O cadastro persistido impede fallback para execução real, inclusive quando a flag `demo_mode_enabled` está desabilitada.

```bash
# Inicie Studio com Postgres/NATS e sua configuração normal.
# Para a instância local de avaliação:
DATABASE_URL='' NATS_URL='' S3_ENDPOINT='' SKIP_MINIO=true \
  DEPLOYMENT_ADMIN_EMAILS='seu-email-local' \
  bun --no-env-file run apps/api/src/cli.ts dev \
  --home /tmp/studio-demo-review --port 3107 --vite-port 4107 \
  --base-url http://localhost:4107 --no-tui

# Em outro terminal, importe um pacote já preparado numa org nova:
bun run demo:setup --home /tmp/studio-demo-review \
  --org sales-demo --bundle /caminho/repository-bundle.json \
  --url http://localhost:4107
```

Em um deployment normal, use `DATABASE_URL` e omita `--home`. Se houver vários usuários, acrescente `--owner EMAIL` de um membro existente. O administrador do painel deve constar em `DEPLOYMENT_ADMIN_EMAILS`, ter email verificado e estar autenticado. O token administrativo compartilhado não autoriza reset.

O CLI recusa converter uma org com tarefas, chats, repositórios ou automações. `demo:setup` sem `--bundle` pode ser repetido sem reset; um pacote importado é imutável. Para avaliar outra versão da loja, prepare outro pacote e crie outra org. Configurações, membros e login sobrevivem ao reset.

## Preparar o pacote a partir dos repositórios

A preparação precisa das dependências externas; a apresentação usa o resultado salvo. Use um checkout dedicado da loja, sem credenciais de produção ou alterações locais. Inicie seu servidor e faça o build web do Reports seguindo os comandos desses repositórios. Baixe o diagnóstico **público** da própria loja para um arquivo local.

```bash
# O preparador usa Chromium; instale-o se ainda não estiver disponível.
bunx playwright install chromium

bun run demo:prepare \
  --storefront /caminho/demo-storefront \
  --url http://127.0.0.1:4110 \
  --reports /caminho/reports \
  --diagnostic /caminho/public-diagnostic.json \
  --output /caminho/repository-bundle.json
```

O preparador registra os commits, captura DOM/CSS/imagens, aplica patches temporários ao header para capturar as variantes e restaura o arquivo original ao terminar. A estrutura dos patches corresponde à loja examinada; uma mudança incompatível no repositório deve exigir revisão do preparador. O widget vem de `reports/dist/client/index.html`, sem uma implementação paralela de Reports no Studio. As imagens do diagnóstico são incorporadas ao resultado para funcionar dentro do iframe sem chamadas externas.

O pacote contém HTML executável e deve ser tratado como artefato de deployment confiável. Somente o CLI administrativo pode importá-lo; não há upload por membros da org. O preparador remove scripts de hidratação e handlers da loja antes de incluir as interações locais. Não exporte `.env`, credenciais, payloads privados ou histórico de clientes. O pacote desta avaliação não é commitado.

## Reset e execução

```bash
bun run demo:reset --home /tmp/studio-demo-review \
  --org demo-storefront --url http://localhost:4107
```

O painel chama `POST /api/_admin/orgs/:id/demo/reset` com `idempotencyKey` e `expectedGeneration`. Reset e mutações usam o mesmo lock transacional. A restauração substitui tarefas/chats, cria IDs novos e incrementa a geração. Repetir a chave não apaga trabalho novamente; uma geração desatualizada retorna conflito. Callbacks antigos não recriam dados.

O painel emite SSE para atualizar abas abertas. O CLI escreve no banco; recarregue a aba após usá-lo. Pode ser chamado por cron, mas este PR não instala um reset automático. As etapas DBOS persistidas dispensam provisionamento de sandbox e admissão na fila de agentes. Um reconciliador recupera admissões interrompidas; uma falha terminal libera o card para nova execução.

## Limites desta versão

- Os previews são capturas da loja com interações preparadas de busca, navegação local e countdown. Não são uma cópia completa do checkout, conta do cliente ou PDP. Links permanecem no catálogo capturado.
- Reports usa o widget real e um resultado público real, congelado. Conectar provedores, enviar compartilhamentos, chat livre sobre o relatório e novos scans não fazem parte do roteiro. O adaptador não chama serviços externos.
- O board permite criar, comentar, editar, executar e aprovar os roteiros cobertos. Pedidos sem resultado preparado são recusados; não acionam um agente real.
- Não há agenda comercial fictícia nem execução de automações externas. O reset conserva autenticação e configurações da org.
- API, banco, DBOS e rede local continuam necessários. O modo elimina a variabilidade dos provedores durante a apresentação, sem prometer disponibilidade durante uma queda desses serviços.

## Validação

A suíte `packages/e2e/tests/demo-organization.spec.ts` usa autenticação, Postgres, API, DBOS e navegador reais. Cobre MCP e recurso de Reports, execução, persistência, preview, publicação, cancelamento, suspensão, reset concorrente/idempotente, isolamento entre orgs, referências antigas e autorização do painel administrativo. O servidor da suíte deve incluir `demo-admin@e2e.local` em `DEPLOYMENT_ADMIN_EMAILS`.

A inspeção do ambiente com o pacote real verifica separadamente o widget original, o catálogo, as imagens locais e a busca. Veja as capturas e os resultados de qualidade no PR.
