import type { assets as enAssets } from "../en/assets.ts";

export const assets = {
  "assets.browser.title": "Assets",
  "assets.browser.bucketLabel": "Bucket: {name}",
  "assets.browser.noBucketTitle": "Nenhum bucket de assets para este site",
  "assets.browser.noBucketDescription":
    "Configure e associe um bucket compatível com S3 a este site para navegar e enviar assets aqui.",
  "assets.browser.deleteAction": "Excluir",
  "assets.browser.deleteConfirmTitle": "Excluir arquivo?",
  "assets.browser.deleteConfirmDescription":
    'Excluir permanentemente "{name}" do bucket? Isso não pode ser desfeito.',
  "assets.browser.deleteCancel": "Cancelar",
  "assets.browser.deleteConfirm": "Excluir",
  "assets.browser.deleted": "Arquivo excluído",
  "assets.browser.deleteFailed": "Falha ao excluir o arquivo",
} satisfies Record<keyof typeof enAssets, string>;
