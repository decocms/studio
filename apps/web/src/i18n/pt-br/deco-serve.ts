import type { decoServe as decoServeEn } from "../en/deco-serve.ts";

export const decoServe = {
  "decoServe.readOnly.label": "Somente leitura",
  "decoServe.readOnly.tooltip":
    "O deco serve foi iniciado com `--read-only`, então as mudanças não podem ser salvas. Reinicie sem essa opção para editar.",
  "decoServe.connect.reaching": "Conectando ao deco serve em {host}…",

  "decoServe.waiting.title": "Aguardando seu computador",
  "decoServe.waiting.lead":
    "Seu preview e seu conteúdo abrem aqui assim que o Studio se conectar ao deco serve neste computador.",
  "decoServe.waiting.step2.title": "O Studio se conecta sozinho",
  "decoServe.waiting.step2.body":
    "Deixe esta aba aberta. Seu preview abre aqui assim que o deco serve iniciar.",
  "decoServe.guide.step1.title": "Inicie o deco serve na pasta do seu site",
  "decoServe.guide.step1.body":
    "Em um terminal, na pasta do seu site (a que tem a pasta `.deco`), rode:",
  "decoServe.guide.copy": "Copiar comando",
  "decoServe.guide.copyShort": "Copiar",
  "decoServe.guide.copied": "Copiado",
  "decoServe.guide.copiedAnnouncement":
    "Comando copiado para a área de transferência",
  "decoServe.guide.step2.looking": "Procurando o deco serve em {hosts}…",
  "decoServe.guide.step2.paused":
    "Pausado enquanto esta aba está em segundo plano. A busca recomeça quando você voltar.",
  "decoServe.guide.step2.start": "Procurar o deco serve neste computador",

  "decoServe.docs.heading": "Saiba mais",
  "decoServe.docs.quickstart": "Primeiros passos",
  "decoServe.docs.siteEditor": "Guia do editor do site",
  "decoServe.docs.serve": "Opções do deco serve",
  "decoServe.docs.schema": "deco schema",
  "decoServe.docs.troubleshooting": "Solução de problemas",
  "decoServe.docs.newTab": "(abre em uma nova aba)",

  "decoServe.link.invalidTitle":
    "Este link não aponta para o deco serve no seu computador",
  "decoServe.link.invalidBody":
    "Links do editor do site só abrem um deco serve rodando neste computador (localhost). Copie de novo o link do Site editor no terminal, ou siga os passos abaixo.",
  "decoServe.lna.deniedTitle":
    "O Chrome está impedindo o Studio de acessar seu computador",
  "decoServe.lna.deniedBody":
    "O Studio precisa de permissão para se conectar ao deco serve neste computador. Clique no ícone à esquerda da barra de endereço, permita o acesso a apps neste dispositivo (acesso à rede local) e recarregue esta página.",

  "decoServe.state.notAnswering.title": "O deco serve não está respondendo",
  "decoServe.state.notAnswering.short":
    "O deco serve em {host} não está respondendo. A reconexão é automática quando ele voltar.",
  "decoServe.state.outdated.title": "Este deco serve está desatualizado",
  "decoServe.state.outdated.body":
    "O servidor em {host} pede um token de acesso, como as versões antigas do deco serve faziam. Atualize o @decocms/blocks do seu site para a versão mais recente e inicie o deco serve de novo.",
  "decoServe.state.versionMismatch.title":
    "Este Studio e o deco serve não são compatíveis",
  "decoServe.state.versionMismatch.body":
    "O deco serve em {host} é de uma versão principal do Blocks diferente da deste Studio, então os dois não conseguem editar o conteúdo juntos. Atualize o @decocms/blocks do seu site e reinicie o deco serve.",
  "decoServe.state.notDecoServe.title": "Outro programa está usando {host}",
  "decoServe.state.notDecoServe.body":
    "Algo que não é o deco serve respondeu em {host}. Inicie o deco serve em outra porta com `--port 4546` e abra o link do Site editor que ele mostra.",
  "decoServe.state.error.title":
    "O deco serve não conseguiu abrir seu conteúdo",
  "decoServe.state.error.body":
    'Ele respondeu, mas com um erro: "{detail}". Veja os detalhes no terminal onde o deco serve está rodando e tente de novo.',

  "decoServe.save.conflict":
    "Não salvo: este conteúdo mudou no seu computador depois que você o abriu (no editor de código ou pelo git, por exemplo). O Studio está carregando a versão mais recente. Refaça sua mudança sobre ela.",
  "decoServe.save.readOnly":
    "Não salvo: o deco serve está em somente leitura (iniciado com --read-only). Reinicie sem essa opção para salvar.",
  "decoServe.save.invalid":
    "Não salvo: o deco serve recusou este conteúdo: {detail}",
  "decoServe.save.tooLarge":
    "Não salvo: este conteúdo é maior do que o deco serve aceita. Diminua o tamanho e tente de novo.",
  "decoServe.save.serverGone":
    "Não salvo: o deco serve parou de responder. Inicie de novo e repita a mudança.",
  "decoServe.upload.failed": "Não foi possível enviar {name}: {detail}",
  "decoServe.upload.serverGone":
    "Não foi possível enviar {name}: o deco serve parou de responder. Inicie de novo e tente outra vez.",
  "decoServe.upload.readOnly":
    "Não foi possível enviar {name}: o deco serve está em somente leitura (iniciado com --read-only).",

  "decoServe.version.v8":
    "Blocks v8: o Studio edita os arquivos de conteúdo do seu site diretamente, sem rodar o código do site.",
} satisfies Record<keyof typeof decoServeEn, string>;
