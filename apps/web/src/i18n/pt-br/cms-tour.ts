import type { cmsTour as cmsTourEn } from "../en/cms-tour.ts";

export const cmsTour = {
  "cmsTour.menuItem": "Tour visual",
  "cmsTour.preview.title": "Visualização",
  "cmsTour.preview.description":
    "Veja seu site atualizar em tempo real enquanto edita — esta é a sua prévia de trabalho.",
  "cmsTour.dropdown.title": "Mais visualizações",
  "cmsTour.dropdown.description":
    "Código, Conteúdo e Biblioteca ficam aqui — abra este menu para alternar entre eles.",
  "cmsTour.edit.title": "CMS",
  "cmsTour.edit.description":
    "Abra o editor para mexer nas seções da página que você está vendo.",
  "cmsTour.visualEditor.title": "Editor visual",
  "cmsTour.visualEditor.description":
    "Ative para clicar em qualquer seção direto na página e editar ali mesmo.",
  "cmsTour.device.title": "Visualização responsiva",
  "cmsTour.device.description":
    "Alterne entre desktop, tablet e celular para conferir como o layout se adapta.",
  "cmsTour.branches.title": "Branches",
  "cmsTour.branches.description":
    "Cada conjunto de mudanças fica em sua própria branch — troque ou crie uma nova aqui.",
  "cmsTour.submit.title": "Enviar para revisão",
  "cmsTour.submit.description":
    "Envie suas mudanças como um pull request para o time revisar antes de irem ao ar.",
  "cmsTour.publish.title": "Revisar e publicar",
  "cmsTour.publish.description":
    "Publique suas mudanças no site quando estiverem prontas.",
  "cmsTour.next": "Próximo",
  "cmsTour.prev": "Voltar",
  "cmsTour.done": "Entendi",
  "cmsTour.skip": "Pular",
  "cmsTour.progress": "{{current}} de {{total}}",
} satisfies Record<keyof typeof cmsTourEn, string>;
