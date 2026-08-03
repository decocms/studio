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
  "commerceOnboarding.companionCard.grantAccessDescription":
    "Conceda acesso ao nosso leitor e informe o identificador",
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
  "commerceOnboarding.saBindingForm.bind": "Vincular",
  "commerceOnboarding.saBindingForm.bindError": "Não foi possível vincular.",
  "commerceOnboarding.saBindingForm.cancel": "Cancelar",
  "commerceOnboarding.saBindingForm.connectedSuccess": "{label} conectado",
  "commerceOnboarding.saBindingForm.copyEmailLabel":
    "Copiar e-mail do service account",
  "commerceOnboarding.saBindingForm.emailCopied": "E-mail copiado",
  "commerceOnboarding.saBindingForm.googleLoginAlternative":
    "autorizar via login do Google",
  "commerceOnboarding.saBindingForm.resourceIdRequired":
    "Informe o {resourceLabel}",
  "commerceOnboarding.saBindingForm.storeUrlUnavailable":
    "URL da loja indisponível — recarregue a página.",
  "commerceOnboarding.saBindingForm.verifying": "Verificando...",
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
  "commerceOnboarding.shopifyConfigForm.accessTokenLabel":
    "Access token da Admin API",
  "commerceOnboarding.shopifyConfigForm.accessTokenPlaceholder": "shpat_...",
  "commerceOnboarding.shopifyConfigForm.apiVersionLabel":
    "Versão da API (opcional)",
  "commerceOnboarding.shopifyConfigForm.apiVersionPlaceholder": "2026-07",
  "commerceOnboarding.shopifyConfigForm.cancelButton": "Cancelar",
  "commerceOnboarding.shopifyConfigForm.saveButton": "Salvar",
  "commerceOnboarding.shopifyConfigForm.savingButton": "Salvando...",
  "commerceOnboarding.shopifyConfigForm.savingError":
    "Não foi possível salvar a configuração",
} satisfies Record<keyof typeof commerceOnboardingEn, string>;
