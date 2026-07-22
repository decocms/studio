import type { filePicker as filePickerEn } from "../en/file-picker.ts";

export const filePicker = {
  "filePicker.filePickerDialog.assetActions": "Ações do ativo",
  "filePicker.filePickerDialog.commonMediaTypes":
    "Tipos comuns de imagem, vídeo, áudio e documentos.",
  "filePicker.filePickerDialog.configureABucket": "Configurar um bucket",
  "filePicker.filePickerDialog.copied": "Copiado",
  "filePicker.filePickerDialog.copyUrl": "Copiar URL",
  "filePicker.filePickerDialog.description":
    "Fazer upload de um novo arquivo ou escolher um já enviado para um bucket configurado.",
  "filePicker.filePickerDialog.dropFileToGetStarted":
    "Arraste um arquivo acima para começar.",
  "filePicker.filePickerDialog.dropFilesOrClick":
    "Arraste arquivos aqui ou clique para fazer upload",
  "filePicker.filePickerDialog.failedToCopyUrl": "Falha ao copiar a URL",
  "filePicker.filePickerDialog.failedToLoadBuckets":
    "Falha ao carregar os buckets",
  "filePicker.filePickerDialog.imagesOnlyTypes":
    "Apenas imagens (PNG, JPEG, WebP, GIF, SVG, AVIF).",
  "filePicker.filePickerDialog.loadMore": "Carregar mais",
  "filePicker.filePickerDialog.loading": "Carregando…",
  "filePicker.filePickerDialog.noBucketConfigured": "Nenhum bucket configurado",
  "filePicker.filePickerDialog.noBucketDescription":
    "Adicione um bucket compatível com S3 nas Configurações antes de fazer upload de arquivos.",
  "filePicker.filePickerDialog.noFilesYet": "Nenhum arquivo neste bucket ainda",
  "filePicker.filePickerDialog.noImagesFormatDesc":
    "O bucket contém outros arquivos, mas nenhum corresponde a formatos de imagem comuns.",
  "filePicker.filePickerDialog.noImagesYet":
    "Nenhuma imagem neste bucket ainda",
  "filePicker.filePickerDialog.noMatches":
    'Nenhuma correspondência para "{query}"',
  "filePicker.filePickerDialog.openInNewTab": "Abrir em nova aba",
  "filePicker.filePickerDialog.pickAFile": "Escolher um arquivo",
  "filePicker.filePickerDialog.pickAnImage": "Escolher uma imagem",
  "filePicker.filePickerDialog.searchFilesPlaceholder": "Pesquisar arquivos…",
  "filePicker.filePickerDialog.searchImagesPlaceholder": "Pesquisar imagens…",
  "filePicker.filePickerDialog.tryDifferentSearchOrLoadMore":
    "Tente uma pesquisa diferente ou carregue mais arquivos abaixo.",
  "filePicker.filePickerDialog.uploadFailedAll": "Falha no upload: {errors}",
  "filePicker.filePickerDialog.uploadFailedSome":
    "Alguns arquivos falharam: {errors}",
  "filePicker.filePickerDialog.uploadSizeLimit": "Até 100 MB.",
  "filePicker.filePickerDialog.uploading": "Enviando…",
  "filePicker.filePickerDialog.useThis": "Usar este",
} satisfies Record<keyof typeof filePickerEn, string>;
