/**
 * Captura da loja no ar: prints e medidas de PDPs reais, e o design system.
 *
 * Roda dentro de UMA sessão de navegador (o chamador abre com withBrowser):
 * abrir o Chrome é a parte cara, e a mesma sessão serve pras duas PDPs nos dois
 * dispositivos e pro design system.
 */

import {
  openPage,
  screenshotClip,
  screenshotFold,
  screenshotFull,
  storeImage,
} from "./browser.ts";
import {
  domExcerptInPage,
  elementLabelsInPage,
  extractDesignSystemInPage,
  measurePdpInPage,
  measureSitePageInPage,
} from "./page-scripts.ts";
import type { BrowserPort, MediaStore } from "./ports.ts";
import type {
  BoxStyle,
  DesignSystem,
  PageCapture,
  TextStyle,
  UxDevice,
  UxPageType,
} from "./types.ts";

export interface CaptureTarget {
  url: string;
  product_id: string | null;
  /** Estoque do produto, quando se sabe: vai junto do print pro modelo. */
  stock?: PageCapture["stock"];
}

/**
 * Abre a PDP, mede, tira os prints (primeira tela e página inteira) e guarda
 * na mídia da org sob `keyPrefix`. `elementKeys` são os `root|el` do heatmap
 * deste dispositivo: a página diz o que cada um é.
 */
export async function capturePdp(
  browser: BrowserPort,
  media: MediaStore,
  target: CaptureTarget,
  device: UxDevice,
  keyPrefix: string,
  elementKeys: string[] = [],
): Promise<PageCapture> {
  const page = await openPage(browser, target.url, device);
  try {
    const measured = await page.evaluate(measurePdpInPage);
    // Sem rótulo, o elemento ainda entra no prompt pelo nome da seção.
    const elementLabels =
      elementKeys.length > 0
        ? await page
            .evaluate(elementLabelsInPage, elementKeys)
            .catch(() => ({}))
        : {};
    const dom = await page.evaluate(
      domExcerptInPage,
      measured.selectors.buy_button ?? measured.selectors.price,
    );
    const fold = await screenshotFold(page);
    const full = await screenshotFull(page);
    const [foldUrl, fullUrl] = await Promise.all([
      storeImage(media, `${keyPrefix}/${device}-fold.jpg`, fold),
      storeImage(media, `${keyPrefix}/${device}-full.jpg`, full),
    ]);
    return {
      device,
      url: target.url,
      product_id: target.product_id,
      viewport: { width: page.viewport.width, height: page.viewport.height },
      page_height: measured.page_height,
      fold_url: foldUrl,
      full_url: fullUrl,
      positions: measured.positions,
      has_sticky_buy: measured.has_sticky_buy,
      sold_out_signal: measured.sold_out_signal,
      above_fold_outline: measured.above_fold_outline,
      selectors: measured.selectors,
      dom_excerpt: dom,
      stock: target.stock ?? null,
      element_labels: elementLabels,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Abre home, categoria ou busca, mede (measureSitePageInPage), tira os prints
 * e guarda na mídia da org. O mesmo contrato da PDP (PageCapture), com as
 * partes da página no lugar de preço/tamanho/botão e os fatos dela em `facts`.
 */
export async function captureSitePage(
  browser: BrowserPort,
  media: MediaStore,
  target: CaptureTarget,
  device: UxDevice,
  keyPrefix: string,
  kind: Exclude<UxPageType, "pdp" | "carrinho_checkout">,
  elementKeys: string[] = [],
): Promise<PageCapture> {
  const page = await openPage(browser, target.url, device);
  try {
    const measured = await page.evaluate(measureSitePageInPage, kind);
    const elementLabels =
      elementKeys.length > 0
        ? await page
            .evaluate(elementLabelsInPage, elementKeys)
            .catch(() => ({}))
        : {};
    const anchor =
      measured.selectors.first_card ??
      measured.selectors.first_product ??
      measured.selectors.filter_button ??
      measured.selectors.hero ??
      null;
    const dom = await page.evaluate(domExcerptInPage, anchor);
    const fold = await screenshotFold(page);
    const full = await screenshotFull(page);
    const [foldUrl, fullUrl] = await Promise.all([
      storeImage(media, `${keyPrefix}/${device}-fold.jpg`, fold),
      storeImage(media, `${keyPrefix}/${device}-full.jpg`, full),
    ]);
    return {
      device,
      page_type: kind,
      url: target.url,
      product_id: null,
      viewport: { width: page.viewport.width, height: page.viewport.height },
      page_height: measured.page_height,
      fold_url: foldUrl,
      full_url: fullUrl,
      positions: measured.positions,
      has_sticky_buy: false,
      sold_out_signal: false,
      above_fold_outline: measured.above_fold_outline,
      selectors: measured.selectors,
      facts: measured.facts,
      dom_excerpt: dom,
      stock: null,
      element_labels: elementLabels,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Lê o design system da loja numa PDP (é onde estão botão de compra, chip de
 * tamanho e preço — os componentes que um mockup de PDP reusa) e guarda o
 * print do bloco de compra.
 */
export async function captureDesignSystem(
  browser: BrowserPort,
  media: MediaStore,
  url: string,
  keyPrefix: string,
  now: string,
): Promise<DesignSystem> {
  const page = await openPage(browser, url, "mobile");
  try {
    const raw = await page.evaluate(extractDesignSystemInPage);
    let buyBoxUrl: string | null = null;
    if (raw.buy_box) {
      const bytes = await screenshotClip(page, raw.buy_box);
      buyBoxUrl = await storeImage(media, `${keyPrefix}/buy-box.jpg`, bytes);
    }
    return {
      source_url: url,
      captured_at: now,
      css_variables: raw.css_variables,
      palette: raw.palette,
      fonts: raw.fonts,
      typography: {
        body: raw.typography.body as TextStyle | null,
        heading: raw.typography.heading as TextStyle | null,
        price: raw.typography.price as TextStyle | null,
        link: raw.typography.link as TextStyle | null,
      },
      components: {
        primary_button: raw.components.primary_button as BoxStyle | null,
        secondary_button: raw.components.secondary_button as BoxStyle | null,
        size_chip: raw.components.size_chip as BoxStyle | null,
        badge: raw.components.badge as BoxStyle | null,
        input: raw.components.input as BoxStyle | null,
      },
      radii: raw.radii,
      spacing: raw.spacing,
      buy_box_url: buyBoxUrl,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
