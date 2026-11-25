/**
 * De onde vem cada artigo da curadoria: a editora (vira a pasta na tela) e o
 * título original (conferido na página em 16/11/2026). Só a tela lê isto; o
 * prompt continua lendo `fonte` (select.ts).
 *
 * Entrada curada nova precisa de artigo aqui: o teste (knowledge.test.ts)
 * quebra se uma `fonte_url` ficar sem.
 */

export type PublisherKey =
  | "baymard"
  | "nngroup"
  | "google"
  | "vwo"
  | "spiegel"
  | "w3c"
  | "academico"
  | "outras";

export interface Publisher {
  key: PublisherKey;
  nome: string;
  /** Domínio mostrado na pasta; null = grupo de várias fontes. */
  dominio: string | null;
}

/** Na ordem das pastas. */
export const PUBLISHERS: Publisher[] = [
  { key: "baymard", nome: "Baymard Institute", dominio: "baymard.com" },
  { key: "nngroup", nome: "Nielsen Norman Group", dominio: "nngroup.com" },
  { key: "google", nome: "Google", dominio: "web.dev" },
  { key: "vwo", nome: "VWO", dominio: "wingify.com" },
  {
    key: "spiegel",
    nome: "Spiegel Research Center",
    dominio: "northwestern.edu",
  },
  { key: "w3c", nome: "W3C", dominio: "w3.org" },
  { key: "academico", nome: "Pesquisa acadêmica", dominio: null },
  { key: "outras", nome: "Outras fontes", dominio: null },
];

export interface ArticleSource {
  editora: PublisherKey;
  /** Título original, no idioma da fonte. */
  titulo: string;
}

const a = (editora: PublisherKey, titulo: string): ArticleSource => ({
  editora,
  titulo,
});

/** Por `fonte_url` (várias entradas podem sair do mesmo artigo). */
export const ARTICLES: Record<string, ArticleSource> = {
  // Baymard
  "https://baymard.com/lists/cart-abandonment-rate": a(
    "baymard",
    "Cart Abandonment Rate: 50 Statistics & Why People Abandon",
  ),
  "https://baymard.com/research/ecommerce-product-lists": a(
    "baymard",
    "E-Commerce Product Lists & Filtering UX",
  ),
  "https://baymard.com/research-articles/have-filters-for-list-item-info": a(
    "baymard",
    "Filter List Design: Have Filters for All Displayed List Item Info (38% Don't)",
  ),
  "https://baymard.com/research-articles/allow-applying-of-multiple-filter-values":
    a("baymard", "Filtering UX: Combining Filter Options"),
  "https://baymard.com/blog/number-of-items-loaded-by-default": a(
    "baymard",
    "Product List UX: Number of Products to Load",
  ),
  "https://baymard.com/blog/return-same-place": a(
    "baymard",
    "Return Users to the Same Place in the Product List When Returning from the Product Page (13% Don’t)",
  ),
  "https://baymard.com/research-articles/product-listing-information": a(
    "baymard",
    "Product Listing UX: What Information to Display in Product Listings (50% Get It Wrong)",
  ),
  "https://baymard.com/blog/ecommerce-category-page": a(
    "baymard",
    "Ecommerce Category Pages: Definition, Usage, & Design Tips",
  ),
  "https://baymard.com/blog/autocomplete-design": a(
    "baymard",
    "9 UX Best Practice Design Patterns for Autocomplete Suggestions (Only 19% Get Everything Right)",
  ),
  "https://baymard.com/blog/offer-autocomplete-suggestions-for-misspellings": a(
    "baymard",
    "Offer Relevant Autocomplete Suggestions for Closely Misspelled Search Terms and Queries (69% Don’t)",
  ),
  "https://baymard.com/blog/no-results-page": a(
    "baymard",
    "5 Proven UX Strategies For “No Results” Pages",
  ),
  "https://baymard.com/blog/autodirect-searches-matching-category-scopes": a(
    "baymard",
    "Search UX: Autodirect or Guide Users to Matching Category Scopes (46% Get It Wrong)",
  ),
  "https://baymard.com/blog/ecommerce-homepage-ux": a(
    "baymard",
    "Homepage UX Best Practices",
  ),
  "https://baymard.com/blog/mobile-ecommerce-search-and-navigation": a(
    "baymard",
    "The State of Mobile E-Commerce Search and Category Navigation",
  ),
  "https://baymard.com/blog/checkout-flow-ux-optimization": a(
    "baymard",
    "Ecommerce Checkout UX Guide: Optimize Your Order Flow",
  ),
  "https://baymard.com/research-articles/inline-form-validation": a(
    "baymard",
    "Usability Testing of Inline Form Validation",
  ),
  "https://baymard.com/blog/required-optional-form-fields": a(
    "baymard",
    "E-Commerce Checkouts Need to Mark Both Required Fields and Optional Fields Explicitly (Only 14% Do So)",
  ),
  "https://baymard.com/research-articles/mobile-ecommerce-checkout-forms": a(
    "baymard",
    "The State of Mobile Checkout & Form Usability",
  ),
  "https://baymard.com/blog/site-seal-trust": a(
    "baymard",
    "Which Site Seal do People Trust the Most? (2013/2016 Survey Results)",
  ),
  "https://baymard.com/blog/ux-statistics": a(
    "baymard",
    "40+ UX Statistics (from 200,000 hours of UX Research)",
  ),

  // Nielsen Norman Group
  "https://www.nngroup.com/articles/scrolling-and-attention/": a(
    "nngroup",
    "Scrolling and Attention",
  ),
  "https://www.nngroup.com/articles/page-fold-manifesto/": a(
    "nngroup",
    "The Fold Manifesto: Why the Page Fold Still Matters",
  ),
  "https://www.nngroup.com/articles/fitts-law/": a(
    "nngroup",
    "Fitts's Law and Its Applications in UX",
  ),
  "https://www.nngroup.com/articles/photos-as-web-content/": a(
    "nngroup",
    "Photos as Web Content",
  ),
  "https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/": a(
    "nngroup",
    "F-Shaped Pattern of Reading: Misunderstood, But Still Relevant",
  ),
  "https://www.nngroup.com/articles/search-visible-and-simple/": a(
    "nngroup",
    "Search: Visible and Simple",
  ),
  "https://www.nngroup.com/articles/hamburger-menus/": a(
    "nngroup",
    "Hamburger Menus and Hidden Navigation Hurt UX Metrics",
  ),
  "https://www.nngroup.com/articles/horizontal-attention-leans-left/": a(
    "nngroup",
    "Horizontal Attention Leans Left",
  ),

  // Google (web.dev e Think with Google)
  "https://www.thinkwithgoogle.com/_qs/documents/9757/Milliseconds_Make_Millions_report_hQYAbZJ.pdf":
    a("google", "Milliseconds Make Millions (Deloitte, 2020)"),
  "https://web.dev/articles/lcp": a("google", "Largest Contentful Paint (LCP)"),
  "https://web.dev/articles/cls": a("google", "Cumulative Layout Shift (CLS)"),
  "https://web.dev/articles/inp": a(
    "google",
    "Interaction to Next Paint (INP)",
  ),
  "https://web.dev/case-studies/rayban-speculation-rules": a(
    "google",
    "How Ray-Ban doubled conversion rate and reduced exit rate by 13% through prerendering using the Speculation Rules API",
  ),
  "https://web.dev/case-studies/vodafone": a(
    "google",
    "Vodafone: A 31% improvement in LCP increased sales by 8%",
  ),
  "https://web.dev/case-studies/rakuten": a(
    "google",
    "How Rakuten 24's investment in Core Web Vitals increased revenue per visitor by 53.37% and conversion rate by 33.13%",
  ),
  "https://web.dev/case-studies/farfetch": a(
    "google",
    "Luxury retailer Farfetch sees higher conversion rates for better Core Web Vitals",
  ),
  "https://web.dev/swappie": a(
    "google",
    "How Swappie increased mobile revenue by 42% by focusing on Core Web Vitals",
  ),
  "https://web.dev/case-studies/nuvemshop": a(
    "google",
    "How Nuvemshop's image prioritization strategy led to a 68% improvement in LCP and 8.9% more conversions",
  ),

  // VWO
  "https://wingify.com/blog/product-filter-ecommerce-ab-testing-revenue/": a(
    "vwo",
    "Buyakilt.com Increased Revenue By 76%",
  ),
  "https://wingify.com/blog/remove-product-filter-increase-site-engagement": a(
    "vwo",
    "UKToolCentre Improved User Experience To Increase Site Engagement By 27%",
  ),

  // Spiegel Research Center
  "https://spiegel.medill.northwestern.edu/how-online-reviews-influence-sales/":
    a("spiegel", "How Online Reviews Influence Sales"),

  // W3C
  "https://www.w3.org/WAI/WCAG21/Understanding/target-size.html": a(
    "w3c",
    "Understanding Success Criterion 2.5.5: Target Size",
  ),

  // Pesquisa acadêmica
  "https://doi.org/10.1037/0022-3514.79.6.995": a(
    "academico",
    "When Choice is Demotivating: Can One Desire Too Much of a Good Thing?",
  ),
  "https://doi.org/10.1086/651235": a(
    "academico",
    "Can There Ever Be Too Many Options? A Meta-Analytic Review of Choice Overload",
  ),
  "https://ideas.repec.org/a/inm/ormksc/v37y2018i4p530-552.html": a(
    "academico",
    "The Power of Rankings: Quantifying the Effect of Rankings on Online Consumer Search and Purchase Decisions",
  ),
  "https://www.nber.org/papers/w25186.pdf": a(
    "academico",
    "Price Salience and Product Choice",
  ),

  // Outras
  "https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php":
    a("outras", "How Do Users Really Hold Mobile Devices?"),
  "https://erikrunyon.com/2013/01/carousel-interaction-stats/": a(
    "outras",
    "Carousel Interaction Stats",
  ),
};

export const articleFor = (url: string | null): ArticleSource | null =>
  url ? (ARTICLES[url] ?? null) : null;
