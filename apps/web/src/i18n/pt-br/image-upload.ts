import type { imageUpload as enImageUpload } from "../en/image-upload.ts";

export const imageUpload = {
  "imageUpload.choose": "Escolher uma imagem",
  "imageUpload.recent": "Usadas recentemente",
  "imageUpload.usePicture": "Usar esta imagem",
  "imageUpload.deletePicture": "Excluir esta imagem",
  "imageUpload.zoom": "Zoom",
  "imageUpload.back": "Escolher outra",
  "imageUpload.save": "Salvar",
  "imageUpload.cancel": "Cancelar",
  "imageUpload.unsupportedType": "Escolha uma imagem PNG, JPEG, GIF ou WebP",
  "imageUpload.tooLarge": "Escolha uma imagem menor que {max} MB",
  "imageUpload.decodeFailed": "Não foi possível ler esse arquivo como imagem",
  "imageUpload.encodeFailed": "Não foi possível processar a imagem",
} satisfies Record<keyof typeof enImageUpload, string>;
