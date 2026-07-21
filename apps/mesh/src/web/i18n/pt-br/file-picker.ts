import type { filePicker as filePickerEn } from "../en/file-picker.ts";

export const filePicker = {
  "filePicker.filePickerDialog.assetActions": "A\u00e7\u00f5es do ativo",
  "filePicker.filePickerDialog.commonMediaTypes":
    "Tipos comuns de imagem, v\u00eddeo, \u00e1udio e documentos.",
  "filePicker.filePickerDialog.configureABucket": "Configurar um bucket",
  "filePicker.filePickerDialog.copied": "Copiado",
  "filePicker.filePickerDialog.copyUrl": "Copiar URL",
  "filePicker.filePickerDialog.description":
    "Fazer upload de um novo arquivo ou escolher um j\u00e1 enviado para um bucket configurado.",
  "filePicker.filePickerDialog.dropFileToGetStarted":
    "Arraste um arquivo acima para come\u00e7ar.",
  "filePicker.filePickerDialog.dropFilesOrClick":
    "Arraste arquivos aqui ou clique para fazer upload",
  "filePicker.filePickerDialog.failedToCopyUrl": "Falha ao copiar a URL",
  "filePicker.filePickerDialog.failedToLoadBuckets":
    "Falha ao carregar os buckets",
  "filePicker.filePickerDialog.imagesOnlyTypes":
    "Apenas imagens (PNG, JPEG, WebP, GIF, SVG, AVIF).",
  "filePicker.filePickerDialog.loadMore": "Carregar mais",
  "filePicker.filePickerDialog.loading": "Carregando\u2026",
  "filePicker.filePickerDialog.noBucketConfigured": "Nenhum bucket configurado",
  "filePicker.filePickerDialog.noBucketDescription":
    "Adicione um bucket compat\u00edvel com S3 nas Configura\u00e7\u00f5es antes de fazer upload de arquivos.",
  "filePicker.filePickerDialog.noFilesYet": "Nenhum arquivo neste bucket ainda",
  "filePicker.filePickerDialog.noImagesFormatDesc":
    "O bucket cont\u00e9m outros arquivos, mas nenhum corresponde a formatos de imagem comuns.",
  "filePicker.filePickerDialog.noImagesYet":
    "Nenhuma imagem neste bucket ainda",
  "filePicker.filePickerDialog.noMatches":
    'Nenhuma correspond\u00eancia para "{query}"',
  "filePicker.filePickerDialog.openInNewTab": "Abrir em nova aba",
  "filePicker.filePickerDialog.pickAFile": "Escolher um arquivo",
  "filePicker.filePickerDialog.pickAnImage": "Escolher uma imagem",
  "filePicker.filePickerDialog.searchFilesPlaceholder":
    "Pesquisar arquivos\u2026",
  "filePicker.filePickerDialog.searchImagesPlaceholder":
    "Pesquisar imagens\u2026",
  "filePicker.filePickerDialog.tryDifferentSearchOrLoadMore":
    "Tente uma pesquisa diferente ou carregue mais arquivos abaixo.",
  "filePicker.filePickerDialog.uploadFailedAll": "Falha no upload: {errors}",
  "filePicker.filePickerDialog.uploadFailedSome":
    "Alguns arquivos falharam: {errors}",
  "filePicker.filePickerDialog.uploadSizeLimit": "At\u00e9 100 MB.",
  "filePicker.filePickerDialog.uploading": "Enviando\u2026",
  "filePicker.filePickerDialog.useThis": "Usar este",
} satisfies Record<keyof typeof filePickerEn, string>;
