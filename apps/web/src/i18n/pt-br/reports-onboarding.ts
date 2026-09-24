import type { reportsOnboarding as reportsOnboardingEn } from "../en/reports-onboarding.ts";

export const reportsOnboarding = {
  "reportsOnboarding.companionCard.configField.accountName": "Nome da conta",
  "reportsOnboarding.companionCard.configField.appKey": "App Key",
  "reportsOnboarding.companionCard.configField.appToken": "App Token",
  "reportsOnboarding.companionCard.configField.propertyId": "Propriedade",
  "reportsOnboarding.companionCard.configField.siteUrl": "Site",
  "reportsOnboarding.companionCard.configure": "Configurar",
  "reportsOnboarding.companionCard.configureAriaLabel": "Configurar {title}",
  "reportsOnboarding.companionCard.configureDescription":
    "Configure o {title} para enriquecer os dados",
  "reportsOnboarding.companionCard.connect": "Conectar",
  "reportsOnboarding.companionCard.connectAriaLabel": "Conectar {title}",
  "reportsOnboarding.companionCard.connected": "Conectado",
  "reportsOnboarding.companionCard.disconnect": "Desconectar",
  "reportsOnboarding.companionCard.disconnectAriaLabel": "Desconectar {title}",
  "reportsOnboarding.companionCard.disconnectError":
    "Não foi possível desconectar. Tente novamente.",
  "reportsOnboarding.companionCard.disconnectedSuccess": "{title} desconectado",
  "reportsOnboarding.companionCard.editConfiguration": "Editar configuração",
  "reportsOnboarding.companionCard.finishSetup": "Concluir configuração",
  "reportsOnboarding.companionCard.required": "Obrigatório",
  "reportsOnboarding.connectSourceDialog.connecting": "Conectando {title}...",
  "reportsOnboarding.connectSourceDialog.loading": "Carregando...",
  "reportsOnboarding.connectSourceDialog.noConnectionMethod":
    "{title} não pode ser conectado: nenhum método de conexão disponível",
  "reportsOnboarding.connectSourceDialog.signInFailed":
    "Não foi possível entrar em {title}: {error}",
  "reportsOnboarding.connectSourceDialog.title": "Conectar fonte de dados",
  "reportsOnboarding.githubConfigForm.cancel": "Cancelar",
  "reportsOnboarding.githubConfigForm.failedToSave":
    "Não foi possível salvar a configuração",
  "reportsOnboarding.githubConfigForm.githubConnectionNotFound":
    "Conexão do GitHub não encontrada.",
  "reportsOnboarding.githubConfigForm.invalidRepository":
    'Repositório inválido: "{repo}". Use o formato owner/nome.',
  "reportsOnboarding.githubConfigForm.loadingRepositories":
    "Carregando repositórios...",
  "reportsOnboarding.githubConfigForm.noGithubInstallation":
    'Nenhuma instalação do GitHub encontrada para "{owner}".',
  "reportsOnboarding.githubConfigForm.noRepositoriesFound":
    "Nenhum repositório encontrado. Digite o nome do repositório (owner/nome) para buscar.",
  "reportsOnboarding.githubConfigForm.save": "Salvar",
  "reportsOnboarding.githubConfigForm.saving": "Salvando...",
  "reportsOnboarding.githubConfigForm.searchFailedPartial":
    "Parte da busca falhou — alguns repositórios podem não ter aparecido. Tente novamente ou digite owner/nome.",
  "reportsOnboarding.githubConfigForm.searchFailedTotal":
    "Não foi possível buscar os repositórios (erro ou tempo esgotado). Tente novamente ou digite o repositório no formato owner/nome.",
  "reportsOnboarding.githubConfigForm.searchRepositoryLabel":
    "Buscar repositório",
  "reportsOnboarding.githubConfigForm.searchRepositoryPlaceholder":
    "Buscar repositório",
  "reportsOnboarding.githubConfigForm.selectRepository":
    "Selecione um repositório",
  "reportsOnboarding.saBindingForm.bind": "Conectar",
  "reportsOnboarding.saBindingForm.bindError": "Não foi possível conectar.",
  "reportsOnboarding.saBindingForm.cancel": "Cancelar",
  "reportsOnboarding.saBindingForm.connectedSuccess": "{label} conectado",
  "reportsOnboarding.saBindingForm.copyEmailLabel":
    "Copiar e-mail da nossa conta leitora",
  "reportsOnboarding.saBindingForm.emailCopied": "E-mail copiado",
  "reportsOnboarding.saBindingForm.googleLoginAlternative":
    "Entrar com o Google mesmo assim",
  "reportsOnboarding.saBindingForm.resourceIdRequired":
    "Informe o {resourceLabel}",
  "reportsOnboarding.saBindingForm.storeUrlUnavailable":
    "URL da loja indisponível. Recarregue a página.",
  "reportsOnboarding.saBindingForm.verifying": "Verificando...",
  "reportsOnboarding.saBinding.sampleDomain": "sualoja.com.br",
  "reportsOnboarding.saBinding.oauthNote":
    "O nosso app ainda está em revisão pelo Google, então a tela de login avisa que ele não é verificado.",
  "reportsOnboarding.saBinding.ga4.openConsole": "Abrir o Google Analytics",
  "reportsOnboarding.saBinding.ga4.step1":
    "No Google Analytics, abra Admin › Acesso à propriedade.",
  "reportsOnboarding.saBinding.ga4.step2":
    "Clique em +, escolha Adicionar usuários, cole este e-mail e marque a função Leitor.",
  "reportsOnboarding.saBinding.ga4.step3":
    "Copie o ID da propriedade em Admin › Detalhes da propriedade e cole aqui.",
  "reportsOnboarding.saBinding.ga4.resourceLabel": "ID da propriedade",
  "reportsOnboarding.saBinding.ga4.resourcePlaceholder": "123456789",
  "reportsOnboarding.saBinding.ga4.resourceHint":
    "Só dígitos, sem o prefixo 'properties/'.",
  "reportsOnboarding.saBinding.gsc.openConsole": "Abrir o Search Console",
  "reportsOnboarding.saBinding.gsc.step1":
    "No Search Console, abra Configurações › Usuários e permissões.",
  "reportsOnboarding.saBinding.gsc.step2":
    "Clique em Adicionar usuário, cole este e-mail e escolha a permissão Total.",
  "reportsOnboarding.saBinding.gsc.step3":
    "Copie o endereço da propriedade exatamente como aparece no seletor e cole aqui.",
  "reportsOnboarding.saBinding.gsc.resourceLabel": "Site ou propriedade",
  "reportsOnboarding.saBinding.gsc.resourcePlaceholder": "sc-domain:{host}",
  "reportsOnboarding.saBinding.gsc.resourceHint":
    "Propriedade de domínio, ou o prefixo de URL completo (https://www.{host}/).",
  "reportsOnboarding.saBinding.remediation.noAccess.title":
    "Ainda não conseguimos acessar este recurso no {label}.",
  "reportsOnboarding.saBinding.remediation.noAccess.ga4.1":
    "Confira se {email} aparece em Admin › Acesso à propriedade com a função Leitor.",
  "reportsOnboarding.saBinding.remediation.noAccess.ga4.2":
    "Confira o ID da propriedade: só dígitos, sem o prefixo 'properties/'.",
  "reportsOnboarding.saBinding.remediation.noAccess.ga4.3":
    "O Google pode levar alguns segundos para aplicar o acesso. Tente de novo.",
  "reportsOnboarding.saBinding.remediation.noAccess.gsc.1":
    "Confira se {email} aparece em Configurações › Usuários e permissões.",
  "reportsOnboarding.saBinding.remediation.noAccess.gsc.2":
    "A permissão precisa ser Total ou Restrita. 'Não verificado' não funciona.",
  "reportsOnboarding.saBinding.remediation.noAccess.gsc.3":
    "Confira se o endereço está exatamente como aparece no Search Console.",
  "reportsOnboarding.saBinding.remediation.noWebStream.title":
    "Esta propriedade do GA4 não tem um fluxo de dados da Web (site) configurado.",
  "reportsOnboarding.saBinding.remediation.noWebStream.1":
    "No GA4, vá em Admin › Fluxos de dados.",
  "reportsOnboarding.saBinding.remediation.noWebStream.2":
    "Clique em Adicionar fluxo › Web.",
  "reportsOnboarding.saBinding.remediation.noWebStream.3":
    "Informe a URL do site da sua loja e salve o fluxo.",
  "reportsOnboarding.saBinding.remediation.noWebStream.4":
    "Volte aqui e tente de novo. Propriedades só de app precisam de vínculo manual, fale com o suporte.",
  "reportsOnboarding.saBinding.remediation.noMatch.title":
    "O recurso informado não corresponde ao domínio desta loja.",
  "reportsOnboarding.saBinding.remediation.noMatch.ga4.1":
    "Confira o ID da propriedade. Provavelmente é de outro site.",
  "reportsOnboarding.saBinding.remediation.noMatch.ga4.2":
    "No GA4, o site medido aparece em Admin › Fluxos de dados › seu fluxo Web › URL do stream.",
  "reportsOnboarding.saBinding.remediation.noMatch.gsc.1":
    "Confira se você escolheu a propriedade do Search Console desta loja.",
  "reportsOnboarding.saBinding.remediation.noMatch.gsc.2":
    "O endereço precisa cobrir o mesmo domínio do Deco Score.",
  "reportsOnboarding.saBinding.remediation.alreadyBound.title":
    "Este recurso já está vinculado a outra loja.",
  "reportsOnboarding.saBinding.remediation.alreadyBound.1":
    "Se ele é mesmo desta loja, fale com o suporte para uma revisão manual.",
  "reportsOnboarding.saBinding.remediation.alreadyBound.2":
    "Se digitou o id errado, confira e tente novamente.",
  "reportsOnboarding.saBinding.remediation.unknown.title":
    "Não foi possível verificar o acesso a este recurso.",
  "reportsOnboarding.saBinding.remediation.unknown.1":
    "Revise os passos acima e tente novamente.",
  "reportsOnboarding.saBinding.remediation.unknown.2":
    "Se continuar falhando, fale com o suporte.",
  "reportsOnboarding.vtexConfigForm.accountNameLabel": "Nome da conta",
  "reportsOnboarding.vtexConfigForm.accountNamePlaceholder":
    "Nome da sua conta VTEX",
  "reportsOnboarding.vtexConfigForm.appKeyLabel": "App Key (opcional)",
  "reportsOnboarding.vtexConfigForm.appKeyPlaceholder": "App Key da VTEX",
  "reportsOnboarding.vtexConfigForm.appTokenLabel": "App Token (opcional)",
  "reportsOnboarding.vtexConfigForm.appTokenPlaceholder": "App Token da VTEX",
  "reportsOnboarding.vtexConfigForm.cancelButton": "Cancelar",
  "reportsOnboarding.vtexConfigForm.saveButton": "Salvar",
  "reportsOnboarding.vtexConfigForm.savingButton": "Salvando...",
  "reportsOnboarding.vtexConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "reportsOnboarding.shopifyConfigForm.storeDomainLabel": "Domínio da loja",
  "reportsOnboarding.shopifyConfigForm.storeDomainPlaceholder":
    "minha-loja.myshopify.com",
  "reportsOnboarding.shopifyConfigForm.storeDomainRequired":
    "Informe o domínio da loja",
  "reportsOnboarding.shopifyConfigForm.accessTokenLabel":
    "Access token da Admin API",
  "reportsOnboarding.shopifyConfigForm.accessTokenRequired":
    "Informe o Admin API access token",
  "reportsOnboarding.shopifyConfigForm.accessTokenPlaceholder": "shpat_...",
  "reportsOnboarding.shopifyConfigForm.apiVersionLabel":
    "Versão da API (opcional)",
  "reportsOnboarding.shopifyConfigForm.apiVersionPlaceholder": "2026-07",
  "reportsOnboarding.shopifyConfigForm.cancelButton": "Cancelar",
  "reportsOnboarding.shopifyConfigForm.saveButton": "Salvar",
  "reportsOnboarding.shopifyConfigForm.savingButton": "Salvando...",
  "reportsOnboarding.shopifyConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "reportsOnboarding.googleSearchConsoleConfigForm.loadingSites":
    "Carregando sites...",
  "reportsOnboarding.googleSearchConsoleConfigForm.loadSitesError":
    "Não foi possível carregar os sites do Google Search Console.",
  "reportsOnboarding.googleSearchConsoleConfigForm.noSitesFound":
    "Nenhum site verificado foi encontrado. Verifique um site no Google Search Console.",
  "reportsOnboarding.googleSearchConsoleConfigForm.siteAriaLabel":
    "Site verificado",
  "reportsOnboarding.googleSearchConsoleConfigForm.siteRequired":
    "Selecione um site",
  "reportsOnboarding.googleSearchConsoleConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "reportsOnboarding.googleSearchConsoleConfigForm.cancelButton": "Cancelar",
  "reportsOnboarding.googleSearchConsoleConfigForm.saveButton": "Salvar",
  "reportsOnboarding.googleSearchConsoleConfigForm.savingButton": "Salvando...",
  "reportsOnboarding.selectableList.searchPlaceholder": "Buscar...",
  "reportsOnboarding.selectableList.searchAriaLabel": "Buscar {label}",
  "reportsOnboarding.selectableList.noResults": "Nenhum resultado",
} satisfies Record<keyof typeof reportsOnboardingEn, string>;
