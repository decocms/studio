import type { reports as reportsEn } from "../en/reports.ts";

export const reports = {
  "reports.authGate.accessYourReport": "Acesse seu relatório",
  "reports.authGate.authSubtitle":
    "Entre ou crie sua conta para receber o relatório por e-mail.",
  "reports.authGate.codeSentTo": "Enviamos um código para {email}",
  "reports.authGate.continueWith": "Continuar com {provider}",
  "reports.authGate.divider": "ou",
  "reports.authGate.emailLabel": "E-mail",
  "reports.authGate.emailPlaceholder": "seu@email.com",
  "reports.authGate.enterCodePlaceholder": "Digite o código",
  "reports.authGate.freeAccess": "Acesso gratuito. Leva menos de um minuto.",
  "reports.authGate.genericError": "Algo deu errado. Tente novamente.",
  "reports.authGate.invalidCode": "Código inválido",
  "reports.authGate.invalidEmail": "Digite um email válido",
  "reports.authGate.invalidOrExpiredCode":
    "Código inválido ou expirado. Tente novamente.",
  "reports.authGate.networkError": "Erro de conexão. Tente novamente.",
  "reports.authGate.otpSendFailed": "Não foi possível enviar o código",
  "reports.authGate.sendCode": "Continuar",
  "reports.authGate.sending": "Enviando...",
  "reports.authGate.tooManyAttempts":
    "Muitas tentativas. Aguarde um momento e tente novamente.",
  "reports.authGate.useDifferentEmail": "Usar outro email",
  "reports.authGate.verificationCodeLabel": "Código de verificação",
  "reports.authGate.verificationCodeTitle": "Digite o código",
  "reports.authGate.verify": "Entrar",
  "reports.authGate.verifying": "Verificando...",
  "reports.scanGate.anonymousHelp":
    "Mandamos o link por e-mail quando ficar pronto.",
  "reports.scanGate.anonymousLabel":
    "Quer receber por e-mail quando ficar pronto?",
  "reports.scanGate.anonymousSignIn": "Entrar para ser avisado",
  "reports.scanGate.errorBlocked":
    "Este relatório não está disponível publicamente.",
  "reports.scanGate.errorEmpty":
    "Escaneamos sua loja, mas o relatório ainda está sendo montado. Verifique em breve.",
  "reports.scanGate.errorFailed":
    "Algo deu errado ao acessar o relatório. Tente novamente.",
  "reports.scanGate.headlineEnd": "sendo preparado.",
  "reports.scanGate.headlineStart": "Seu relatório está",
  "reports.scanGate.notificationHelp": "Avisamos assim que ficar pronto.",
  "reports.scanGate.notificationLabel": "Enviaremos uma notificação para:",
  "reports.scanGate.stageBuilding": "Montando seu relatório",
  "reports.scanGate.stageCollecting": "Coletando dados públicos",
  "reports.scanGate.stageInitiated": "Análise iniciada",
  "reports.scanGate.stageNow": "agora",
  "reports.scanGate.stageReady": "Relatório pronto",
  "reports.scanGate.subtitle":
    "Você pode acompanhar por aqui — leva alguns minutos.",
  "reports.scanGate.tryAnother": "Tentar outra loja",
  "reports.socialProof.alreadyReceived": "Já receberam",
  "reports.banner.storeDefault": "sua loja",
  "reports.banner.generatingTitle": "Gerando seu diagnóstico",
  "reports.banner.readyTitle": "Seu relatório está pronto",
  "reports.banner.generatingSubtitle":
    "Analisando {store}. Isso leva alguns minutos.",
  "reports.banner.readySubtitle": "Veja a análise completa de {store}.",
  "reports.emptyState.title": "Nenhum relatório ainda",
  "reports.emptyState.description":
    "Rode um diagnóstico da sua loja para ver como ela está e o que corrigir primeiro.",
  "reports.emptyState.siteUrlLabel": "URL da loja",
  "reports.emptyState.siteUrlPlaceholder": "sualoja.com.br",
  "reports.emptyState.start": "Iniciar diagnóstico",
  "reports.emptyState.starting": "Iniciando...",
  "reports.emptyState.checkPerformance": "Performance",
  "reports.emptyState.checkSeo": "SEO",
  "reports.emptyState.checkFunnel": "Funil de conversão",
  "reports.emptyState.checkTracking": "Dados e rastreamento",
  "reports.onePager.lede":
    "Diagnóstico público da experiência digital. Só o que qualquer visitante observa de fora.",
  "reports.onePager.ledeScanned":
    "Diagnóstico público da experiência digital, varredura em {date}. Só o que qualquer visitante observa de fora.",
  "reports.onePager.statFailed": "reprovadas",
  "reports.onePager.statPassed": "aprovadas",
  "reports.onePager.statBlocked": "não medidas",
  "reports.onePager.coverageOf": "{measured} de {total} verificações medidas",
  "reports.onePager.coverage": "{measured} verificações medidas",
  "reports.onePager.scoreAria": "Nota {score} de 100",
  "reports.onePager.share": "Compartilhar",
  "reports.onePager.linkCopied": "Link copiado",
  "reports.onePager.agentTitle": "Para o seu agente.",
  "reports.onePager.agentText":
    "O relatório inteiro em Markdown: achados, evidência medida e o que fazer.",
  "reports.onePager.copyPrompt": "Copiar como prompt",
  "reports.onePager.copied": "Copiado ✓",
  "reports.onePager.copyFailed": "Falhou ✕",
  "reports.onePager.openMarkdown": "Abrir .md",
  "reports.onePager.promptPrefix":
    "Segue o diagnóstico da experiência digital de {domain}, em Markdown. Cada item é uma verificação REPROVADA, com a evidência medida. Comece pelos itens críticos: para cada um, diga o que você mudaria e onde, e pergunte o que faltar. Não invente números que não estejam no relatório.",
  "reports.onePager.shotsTitle": "Capturas da jornada",
  "reports.onePager.shotsLede":
    "O que o navegador do nosso agente viu nas páginas amostradas, no mesmo carregamento que decidiu as verificações de acessibilidade e rastreamento.",
  "reports.onePager.shotMobile": "{label} · mobile",
  "reports.onePager.enlarge": "Ampliar: {label}",
  "reports.onePager.close": "Fechar",
  "reports.onePager.pageHome": "Home",
  "reports.onePager.pageProduct": "Página de produto",
  "reports.onePager.pageCategory": "Vitrine de categoria",
  "reports.onePager.pageBlog": "Conteúdo / blog",
  "reports.onePager.areasTitle": "Notas por área",
  "reports.onePager.areaInsufficient": "amostra insuficiente",
  "reports.onePager.areaMeasured": "{count} medidas",
  "reports.onePager.bucketCritical": "Crítico — resolver agora",
  "reports.onePager.bucketImportant": "Importante",
  "reports.onePager.bucketWorth": "Vale fazer",
  "reports.onePager.noFailures":
    "Nenhuma verificação reprovou nesta varredura. A cobertura abaixo diz o que foi medido para chegar a esse resultado.",
  "reports.onePager.failedSr": "Reprovado: ",
  "reports.onePager.chipLever": "alavanca",
  "reports.onePager.driverSessions": "Tráfego",
  "reports.onePager.driverConversion": "Conversão",
  "reports.onePager.driverOrderValue": "Ticket médio",
  "reports.onePager.driverRepeat": "Recompra",
  "reports.onePager.controlAgent": "Corrigível pelo agente",
  "reports.onePager.controlClient": "Depende do time do site",
  "reports.onePager.controlExternal": "Depende de terceiro",
  "reports.onePager.partWhat": "O que está acontecendo",
  "reports.onePager.partWhy": "Por que isso importa",
  "reports.onePager.partHow": "Como resolver",
  "reports.onePager.partEvidence": "Evidência medida",
  "reports.onePager.metaCheck": "Verificação:",
  "reports.onePager.metaSample": "Amostra: {value}",
  "reports.onePager.metaSource": "Fonte: {value}",
  "reports.onePager.metaPages": "Observado em: {value}",
  "reports.onePager.fix": "Corrigir automaticamente",
  "reports.onePager.fixNote":
    "Conecte o repositório e o agente da deco abre o PR desta correção.",
  "reports.onePager.fixDependsClient":
    "A correção depende de acesso ou decisão do time do site.",
  "reports.onePager.fixDependsExternal":
    "A correção depende de um terceiro: plataforma, CDN ou fornecedor.",
  "reports.onePager.passingTitle": "Aprovados",
  "reports.onePager.showingOf": "Mostrando {shown} de {total}.",
  "reports.onePager.notMeasuredTitle": "Não medidos, e por quê",
  "reports.onePager.notMeasuredNote":
    "Bloqueado não é aprovado. Cada grupo diz o que impediu a medição.",
  "reports.onePager.checksCount": "{count} verificações",
  "reports.onePager.blockedToolAuth":
    "Aguarda conexão de dados (GA4, Search Console, plataforma)",
  "reports.onePager.blockedDataUnavailable": "A fonte não retornou o dado",
  "reports.onePager.blockedPrecondition":
    "Pré-condição não atendida neste site",
  "reports.onePager.blockedToolUnavailable":
    "Ferramenta indisponível nesta execução",
  "reports.onePager.blockedNotRun": "Não executado nesta varredura",
  "reports.onePager.blockedInterview":
    "Depende de entrevista com o time do site",
  "reports.onePager.blockedManual": "Depende de verificação manual",
  "reports.onePager.ctaTitle": "Isto é só a parte pública.",
  "reports.onePager.ctaText":
    "Este diagnóstico usou apenas o que qualquer visitante observa de fora. O completo conecta GA4, Search Console e a plataforma do site para medir a jornada real e dimensionar cada correção em reais.",
  "reports.onePager.ctaButton": "Rodar o diagnóstico completo",
  "reports.onePager.footerGenerated": "Gerado por decocms",
  "reports.onePager.footerPublicOnly":
    "Somente dados públicos; nada foi acessado com credenciais.",
} satisfies Record<keyof typeof reportsEn, string>;
