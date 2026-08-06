import type { commerceOnboarding as commerceOnboardingEn } from "../en/commerce-onboarding.ts";

export const commerceOnboarding = {
  "commerceOnboarding.companionCard.configure": "Configurar",
  "commerceOnboarding.companionCard.configureAriaLabel": "Configurar {title}",
  "commerceOnboarding.companionCard.configureDescription":
    "Configure o {title} para enriquecer os dados",
  "commerceOnboarding.companionCard.connect": "Conectar",
  "commerceOnboarding.companionCard.connectAriaLabel": "Conectar {title}",
  "commerceOnboarding.companionCard.connected": "Conectado",
  "commerceOnboarding.companionCard.disconnect": "Desconectar",
  "commerceOnboarding.companionCard.disconnectAriaLabel": "Desconectar {title}",
  "commerceOnboarding.companionCard.disconnectError":
    "Não foi possível desconectar. Tente novamente.",
  "commerceOnboarding.companionCard.disconnectedSuccess":
    "{title} desconectado",
  "commerceOnboarding.companionCard.editConfiguration": "Editar configuração",
  "commerceOnboarding.companionCard.finishSetup": "Concluir configuração",
  "commerceOnboarding.companionCard.required": "Obrigatório",
  "commerceOnboarding.githubConfigForm.cancel": "Cancelar",
  "commerceOnboarding.githubConfigForm.failedToSave":
    "Não foi possível salvar a configuração",
  "commerceOnboarding.githubConfigForm.githubConnectionNotFound":
    "Conexão do GitHub não encontrada.",
  "commerceOnboarding.githubConfigForm.invalidRepository":
    'Repositório inválido: "{repo}". Use o formato owner/nome.',
  "commerceOnboarding.githubConfigForm.loadingRepositories":
    "Carregando repositórios...",
  "commerceOnboarding.githubConfigForm.noGithubInstallation":
    'Nenhuma instalação do GitHub encontrada para "{owner}".',
  "commerceOnboarding.githubConfigForm.noRepositoriesFound":
    "Nenhum repositório encontrado. Digite o nome do repositório (owner/nome) para buscar.",
  "commerceOnboarding.githubConfigForm.save": "Salvar",
  "commerceOnboarding.githubConfigForm.saving": "Salvando...",
  "commerceOnboarding.githubConfigForm.searchFailedPartial":
    "Parte da busca falhou — alguns repositórios podem não ter aparecido. Tente novamente ou digite owner/nome.",
  "commerceOnboarding.githubConfigForm.searchFailedTotal":
    "Não foi possível buscar os repositórios (erro ou tempo esgotado). Tente novamente ou digite o repositório no formato owner/nome.",
  "commerceOnboarding.githubConfigForm.searchRepositoryLabel":
    "Buscar repositório",
  "commerceOnboarding.githubConfigForm.searchRepositoryPlaceholder":
    "Buscar repositório",
  "commerceOnboarding.githubConfigForm.selectRepository":
    "Selecione um repositório",
  "commerceOnboarding.saBindingForm.bind": "Conectar",
  "commerceOnboarding.saBindingForm.bindError": "Não foi possível conectar.",
  "commerceOnboarding.saBindingForm.cancel": "Cancelar",
  "commerceOnboarding.saBindingForm.connectedSuccess": "{label} conectado",
  "commerceOnboarding.saBindingForm.copyEmailLabel":
    "Copiar e-mail da nossa conta leitora",
  "commerceOnboarding.saBindingForm.emailCopied": "E-mail copiado",
  "commerceOnboarding.saBindingForm.googleLoginAlternative":
    "Entrar com o Google mesmo assim",
  "commerceOnboarding.saBindingForm.resourceIdRequired":
    "Informe o {resourceLabel}",
  "commerceOnboarding.saBindingForm.storeUrlUnavailable":
    "URL da loja indisponível. Recarregue a página.",
  "commerceOnboarding.saBindingForm.verifying": "Verificando...",
  "commerceOnboarding.saBinding.sampleDomain": "sualoja.com.br",
  "commerceOnboarding.saBinding.oauthNote":
    "O nosso app ainda está em revisão pelo Google, então a tela de login avisa que ele não é verificado.",
  "commerceOnboarding.saBinding.ga4.openConsole": "Abrir o Google Analytics",
  "commerceOnboarding.saBinding.ga4.step1":
    "No Google Analytics, abra Admin › Acesso à propriedade.",
  "commerceOnboarding.saBinding.ga4.step2":
    "Clique em +, escolha Adicionar usuários, cole este e-mail e marque a função Leitor.",
  "commerceOnboarding.saBinding.ga4.step3":
    "Copie o ID da propriedade em Admin › Detalhes da propriedade e cole aqui.",
  "commerceOnboarding.saBinding.ga4.resourceLabel": "ID da propriedade",
  "commerceOnboarding.saBinding.ga4.resourcePlaceholder": "123456789",
  "commerceOnboarding.saBinding.ga4.resourceHint":
    "Só dígitos, sem o prefixo 'properties/'.",
  "commerceOnboarding.saBinding.gsc.openConsole": "Abrir o Search Console",
  "commerceOnboarding.saBinding.gsc.step1":
    "No Search Console, abra Configurações › Usuários e permissões.",
  "commerceOnboarding.saBinding.gsc.step2":
    "Clique em Adicionar usuário, cole este e-mail e escolha a permissão Total.",
  "commerceOnboarding.saBinding.gsc.step3":
    "Copie o endereço da propriedade exatamente como aparece no seletor e cole aqui.",
  "commerceOnboarding.saBinding.gsc.resourceLabel": "Site ou propriedade",
  "commerceOnboarding.saBinding.gsc.resourcePlaceholder": "sc-domain:{host}",
  "commerceOnboarding.saBinding.gsc.resourceHint":
    "Propriedade de domínio, ou o prefixo de URL completo (https://www.{host}/).",
  "commerceOnboarding.saBinding.remediation.noAccess.title":
    "Ainda não conseguimos acessar este recurso no {label}.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.1":
    "Confira se {email} aparece em Admin › Acesso à propriedade com a função Leitor.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.2":
    "Confira o ID da propriedade: só dígitos, sem o prefixo 'properties/'.",
  "commerceOnboarding.saBinding.remediation.noAccess.ga4.3":
    "O Google pode levar alguns segundos para aplicar o acesso. Tente de novo.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.1":
    "Confira se {email} aparece em Configurações › Usuários e permissões.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.2":
    "A permissão precisa ser Total ou Restrita. 'Não verificado' não funciona.",
  "commerceOnboarding.saBinding.remediation.noAccess.gsc.3":
    "Confira se o endereço está exatamente como aparece no Search Console.",
  "commerceOnboarding.saBinding.remediation.noWebStream.title":
    "Esta propriedade do GA4 não tem um fluxo de dados da Web (site) configurado.",
  "commerceOnboarding.saBinding.remediation.noWebStream.1":
    "No GA4, vá em Admin › Fluxos de dados.",
  "commerceOnboarding.saBinding.remediation.noWebStream.2":
    "Clique em Adicionar fluxo › Web.",
  "commerceOnboarding.saBinding.remediation.noWebStream.3":
    "Informe a URL do site da sua loja e salve o fluxo.",
  "commerceOnboarding.saBinding.remediation.noWebStream.4":
    "Volte aqui e tente de novo. Propriedades só de app precisam de vínculo manual, fale com o suporte.",
  "commerceOnboarding.saBinding.remediation.noMatch.title":
    "O recurso informado não corresponde ao domínio desta loja.",
  "commerceOnboarding.saBinding.remediation.noMatch.ga4.1":
    "Confira o ID da propriedade. Provavelmente é de outro site.",
  "commerceOnboarding.saBinding.remediation.noMatch.ga4.2":
    "No GA4, o site medido aparece em Admin › Fluxos de dados › seu fluxo Web › URL do stream.",
  "commerceOnboarding.saBinding.remediation.noMatch.gsc.1":
    "Confira se você escolheu a propriedade do Search Console desta loja.",
  "commerceOnboarding.saBinding.remediation.noMatch.gsc.2":
    "O endereço precisa cobrir o mesmo domínio do diagnóstico.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.title":
    "Este recurso já está vinculado a outra loja.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.1":
    "Se ele é mesmo desta loja, fale com o suporte para uma revisão manual.",
  "commerceOnboarding.saBinding.remediation.alreadyBound.2":
    "Se digitou o id errado, confira e tente novamente.",
  "commerceOnboarding.saBinding.remediation.unknown.title":
    "Não foi possível verificar o acesso a este recurso.",
  "commerceOnboarding.saBinding.remediation.unknown.1":
    "Revise os passos acima e tente novamente.",
  "commerceOnboarding.saBinding.remediation.unknown.2":
    "Se continuar falhando, fale com o suporte.",
  "commerceOnboarding.vtexConfigForm.accountNameLabel": "Nome da conta",
  "commerceOnboarding.vtexConfigForm.accountNamePlaceholder":
    "Nome da sua conta VTEX",
  "commerceOnboarding.vtexConfigForm.appKeyLabel": "App Key (opcional)",
  "commerceOnboarding.vtexConfigForm.appKeyPlaceholder": "App Key da VTEX",
  "commerceOnboarding.vtexConfigForm.appTokenLabel": "App Token (opcional)",
  "commerceOnboarding.vtexConfigForm.appTokenPlaceholder": "App Token da VTEX",
  "commerceOnboarding.vtexConfigForm.cancelButton": "Cancelar",
  "commerceOnboarding.vtexConfigForm.saveButton": "Salvar",
  "commerceOnboarding.vtexConfigForm.savingButton": "Salvando...",
  "commerceOnboarding.vtexConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "commerceOnboarding.shopifyConfigForm.storeDomainLabel": "Domínio da loja",
  "commerceOnboarding.shopifyConfigForm.storeDomainPlaceholder":
    "minha-loja.myshopify.com",
  "commerceOnboarding.shopifyConfigForm.storeDomainRequired":
    "Informe o domínio da loja",
  "commerceOnboarding.shopifyConfigForm.accessTokenLabel":
    "Access token da Admin API",
  "commerceOnboarding.shopifyConfigForm.accessTokenRequired":
    "Informe o Admin API access token",
  "commerceOnboarding.shopifyConfigForm.accessTokenPlaceholder": "shpat_...",
  "commerceOnboarding.shopifyConfigForm.apiVersionLabel":
    "Versão da API (opcional)",
  "commerceOnboarding.shopifyConfigForm.apiVersionPlaceholder": "2026-07",
  "commerceOnboarding.shopifyConfigForm.cancelButton": "Cancelar",
  "commerceOnboarding.shopifyConfigForm.saveButton": "Salvar",
  "commerceOnboarding.shopifyConfigForm.savingButton": "Salvando...",
  "commerceOnboarding.shopifyConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "commerceOnboarding.googleSearchConsoleConfigForm.loadingSites":
    "Carregando sites...",
  "commerceOnboarding.googleSearchConsoleConfigForm.loadSitesError":
    "Não foi possível carregar os sites do Google Search Console.",
  "commerceOnboarding.googleSearchConsoleConfigForm.noSitesFound":
    "Nenhum site verificado foi encontrado. Verifique um site no Google Search Console.",
  "commerceOnboarding.googleSearchConsoleConfigForm.siteAriaLabel":
    "Site verificado",
  "commerceOnboarding.googleSearchConsoleConfigForm.siteRequired":
    "Selecione um site",
  "commerceOnboarding.googleSearchConsoleConfigForm.savingError":
    "Não foi possível salvar a configuração",
  "commerceOnboarding.googleSearchConsoleConfigForm.cancelButton": "Cancelar",
  "commerceOnboarding.googleSearchConsoleConfigForm.saveButton": "Salvar",
  "commerceOnboarding.googleSearchConsoleConfigForm.savingButton":
    "Salvando...",
  "commerceOnboarding.selectableList.searchPlaceholder": "Buscar...",
  "commerceOnboarding.selectableList.searchAriaLabel": "Buscar {label}",
  "commerceOnboarding.selectableList.noResults": "Nenhum resultado",
} satisfies Record<keyof typeof commerceOnboardingEn, string>;
