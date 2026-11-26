/**
 * Synthetic evidence for a fashion store's promo category, trimmed: site only
 * (no app), no per-day cut, no screenshots. It reproduces an opportunity that
 * came out as a cause, measured with a flipped sign and tied to an unrelated hypothesis.
 */
import type { DiagnosisEvidence } from "../types.ts";

export const categoriaPromo: DiagnosisEvidence = {
  window_days: 7,
  page_type: "categoria",
  page_route: "/colecao/promo",
  routes: [
    {
      page: "/colecao/promo",
      views: 291310,
      avg_depth: 69.8,
    },
    {
      page: "/novidades",
      views: 212958,
      avg_depth: 62,
    },
    {
      page: "/colecao/liquida-verao",
      views: 198835,
      avg_depth: 76.2,
    },
    {
      page: "/colecao/vestidos",
      views: 155365,
      avg_depth: 72.9,
    },
    {
      page: "/bazar",
      views: 110178,
      avg_depth: 71.3,
    },
    {
      page: "/colecao",
      views: 89378,
      avg_depth: 64.5,
    },
    {
      page: "/colecao/verao-promo",
      views: 88022,
      avg_depth: 72.7,
    },
    {
      page: "/outlet/bazar",
      views: 45452,
      avg_depth: 71.7,
    },
  ],
  revenue: {
    window_days: 28,
    currency: "BRL",
    by_channel: [
      {
        channel: "APP (9)",
        orders: 124114,
        revenue: 45043006.47,
        avg_ticket: 290.34,
      },
      {
        channel: "Principal (1)",
        orders: 58574,
        revenue: 19812132.68,
        avg_ticket: 270.59,
      },
    ],
  },
  platform_funnel: [
    {
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 1442668,
        },
        {
          event: "view_item",
          count: 919108,
        },
        {
          event: "add_to_cart",
          count: 91238,
        },
        {
          event: "begin_checkout",
          count: 26900,
        },
        {
          event: "purchase",
          count: 11578,
        },
        {
          event: "view_item_list",
          count: 494816,
        },
        {
          event: "select_item",
          count: 187074,
        },
        {
          event: "view_promotion",
          count: 1130819,
        },
        {
          event: "select_promotion",
          count: 78946,
        },
        {
          event: "view_cart",
          count: 84972,
        },
        {
          event: "add_shipping_info",
          count: 24078,
        },
        {
          event: "add_payment_info",
          count: 23462,
        },
      ],
    },
    {
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 232594,
        },
        {
          event: "view_item",
          count: 76551,
        },
        {
          event: "add_to_cart",
          count: 19751,
        },
        {
          event: "begin_checkout",
          count: 7995,
        },
        {
          event: "purchase",
          count: 3971,
        },
        {
          event: "view_item_list",
          count: 152751,
        },
        {
          event: "select_item",
          count: 35494,
        },
        {
          event: "view_promotion",
          count: 192934,
        },
        {
          event: "select_promotion",
          count: 18582,
        },
        {
          event: "view_cart",
          count: 17374,
        },
        {
          event: "add_shipping_info",
          count: 6898,
        },
        {
          event: "add_payment_info",
          count: 6632,
        },
      ],
    },
  ],
  segments: [
    {
      dim: "canal",
      key: "busca_organica",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 106358,
        },
        {
          event: "view_item",
          count: 6552,
        },
        {
          event: "add_to_cart",
          count: 1976,
        },
        {
          event: "begin_checkout",
          count: 823,
        },
        {
          event: "purchase",
          count: 386,
        },
        {
          event: "view_item_list",
          count: 71287,
        },
        {
          event: "select_item",
          count: 3939,
        },
        {
          event: "view_promotion",
          count: 94855,
        },
        {
          event: "select_promotion",
          count: 2673,
        },
        {
          event: "view_cart",
          count: 1816,
        },
        {
          event: "add_shipping_info",
          count: 699,
        },
        {
          event: "add_payment_info",
          count: 663,
        },
      ],
    },
    {
      dim: "canal",
      key: "crm",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 13488,
        },
        {
          event: "view_item",
          count: 9430,
        },
        {
          event: "add_to_cart",
          count: 1938,
        },
        {
          event: "begin_checkout",
          count: 662,
        },
        {
          event: "purchase",
          count: 334,
        },
        {
          event: "view_item_list",
          count: 7488,
        },
        {
          event: "select_item",
          count: 3499,
        },
        {
          event: "view_promotion",
          count: 10820,
        },
        {
          event: "select_promotion",
          count: 1690,
        },
        {
          event: "view_cart",
          count: 1574,
        },
        {
          event: "add_shipping_info",
          count: 575,
        },
        {
          event: "add_payment_info",
          count: 558,
        },
      ],
    },
    {
      dim: "canal",
      key: "direto",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 34603,
        },
        {
          event: "view_item",
          count: 9572,
        },
        {
          event: "add_to_cart",
          count: 3036,
        },
        {
          event: "begin_checkout",
          count: 1371,
        },
        {
          event: "purchase",
          count: 682,
        },
        {
          event: "view_item_list",
          count: 14939,
        },
        {
          event: "select_item",
          count: 4546,
        },
        {
          event: "view_promotion",
          count: 22038,
        },
        {
          event: "select_promotion",
          count: 3311,
        },
        {
          event: "view_cart",
          count: 3010,
        },
        {
          event: "add_shipping_info",
          count: 1207,
        },
        {
          event: "add_payment_info",
          count: 1138,
        },
      ],
    },
    {
      dim: "canal",
      key: "midia_paga",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 61423,
        },
        {
          event: "view_item",
          count: 38503,
        },
        {
          event: "add_to_cart",
          count: 10808,
        },
        {
          event: "begin_checkout",
          count: 4308,
        },
        {
          event: "purchase",
          count: 2171,
        },
        {
          event: "view_item_list",
          count: 49814,
        },
        {
          event: "select_item",
          count: 20656,
        },
        {
          event: "view_promotion",
          count: 51519,
        },
        {
          event: "select_promotion",
          count: 9250,
        },
        {
          event: "view_cart",
          count: 9145,
        },
        {
          event: "add_shipping_info",
          count: 3709,
        },
        {
          event: "add_payment_info",
          count: 3587,
        },
      ],
    },
    {
      dim: "canal",
      key: "outros",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 7969,
        },
        {
          event: "view_item",
          count: 5926,
        },
        {
          event: "add_to_cart",
          count: 1370,
        },
        {
          event: "begin_checkout",
          count: 584,
        },
        {
          event: "purchase",
          count: 280,
        },
        {
          event: "view_item_list",
          count: 4802,
        },
        {
          event: "select_item",
          count: 1662,
        },
        {
          event: "view_promotion",
          count: 6535,
        },
        {
          event: "select_promotion",
          count: 930,
        },
        {
          event: "view_cart",
          count: 1273,
        },
        {
          event: "add_shipping_info",
          count: 495,
        },
        {
          event: "add_payment_info",
          count: 482,
        },
      ],
    },
    {
      dim: "canal",
      key: "referencia",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 838,
        },
        {
          event: "view_item",
          count: 461,
        },
        {
          event: "add_to_cart",
          count: 122,
        },
        {
          event: "begin_checkout",
          count: 62,
        },
        {
          event: "purchase",
          count: 31,
        },
        {
          event: "view_item_list",
          count: 476,
        },
        {
          event: "select_item",
          count: 234,
        },
        {
          event: "view_promotion",
          count: 611,
        },
        {
          event: "select_promotion",
          count: 115,
        },
        {
          event: "view_cart",
          count: 114,
        },
        {
          event: "add_shipping_info",
          count: 54,
        },
        {
          event: "add_payment_info",
          count: 53,
        },
      ],
    },
    {
      dim: "canal",
      key: "social",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 2065,
        },
        {
          event: "view_item",
          count: 1426,
        },
        {
          event: "add_to_cart",
          count: 60,
        },
        {
          event: "begin_checkout",
          count: 24,
        },
        {
          event: "purchase",
          count: 13,
        },
        {
          event: "view_item_list",
          count: 845,
        },
        {
          event: "select_item",
          count: 110,
        },
        {
          event: "view_promotion",
          count: 1944,
        },
        {
          event: "select_promotion",
          count: 106,
        },
        {
          event: "view_cart",
          count: 53,
        },
        {
          event: "add_shipping_info",
          count: 22,
        },
        {
          event: "add_payment_info",
          count: 21,
        },
      ],
    },
    {
      dim: "canal",
      key: "social_pago",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 5850,
        },
        {
          event: "view_item",
          count: 4682,
        },
        {
          event: "add_to_cart",
          count: 442,
        },
        {
          event: "begin_checkout",
          count: 161,
        },
        {
          event: "purchase",
          count: 74,
        },
        {
          event: "view_item_list",
          count: 3101,
        },
        {
          event: "select_item",
          count: 846,
        },
        {
          event: "view_promotion",
          count: 4611,
        },
        {
          event: "select_promotion",
          count: 507,
        },
        {
          event: "view_cart",
          count: 390,
        },
        {
          event: "add_shipping_info",
          count: 138,
        },
        {
          event: "add_payment_info",
          count: 129,
        },
      ],
    },
    {
      dim: "canal",
      key: "busca_organica",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 40052,
        },
        {
          event: "view_item",
          count: 24070,
        },
        {
          event: "add_to_cart",
          count: 4208,
        },
        {
          event: "begin_checkout",
          count: 1249,
        },
        {
          event: "purchase",
          count: 542,
        },
        {
          event: "view_item_list",
          count: 30312,
        },
        {
          event: "select_item",
          count: 15751,
        },
        {
          event: "view_promotion",
          count: 33758,
        },
        {
          event: "select_promotion",
          count: 5783,
        },
        {
          event: "view_cart",
          count: 3810,
        },
        {
          event: "add_shipping_info",
          count: 1090,
        },
        {
          event: "add_payment_info",
          count: 1061,
        },
      ],
    },
    {
      dim: "canal",
      key: "crm",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 26600,
        },
        {
          event: "view_item",
          count: 17234,
        },
        {
          event: "add_to_cart",
          count: 2650,
        },
        {
          event: "begin_checkout",
          count: 994,
        },
        {
          event: "purchase",
          count: 425,
        },
        {
          event: "view_item_list",
          count: 12880,
        },
        {
          event: "select_item",
          count: 6637,
        },
        {
          event: "view_promotion",
          count: 18875,
        },
        {
          event: "select_promotion",
          count: 2321,
        },
        {
          event: "view_cart",
          count: 4473,
        },
        {
          event: "add_shipping_info",
          count: 902,
        },
        {
          event: "add_payment_info",
          count: 890,
        },
      ],
    },
    {
      dim: "canal",
      key: "direto",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 225834,
        },
        {
          event: "view_item",
          count: 99638,
        },
        {
          event: "add_to_cart",
          count: 10398,
        },
        {
          event: "begin_checkout",
          count: 4177,
        },
        {
          event: "purchase",
          count: 2034,
        },
        {
          event: "view_item_list",
          count: 89505,
        },
        {
          event: "select_item",
          count: 22786,
        },
        {
          event: "view_promotion",
          count: 195099,
        },
        {
          event: "select_promotion",
          count: 12205,
        },
        {
          event: "view_cart",
          count: 12090,
        },
        {
          event: "add_shipping_info",
          count: 3786,
        },
        {
          event: "add_payment_info",
          count: 3666,
        },
      ],
    },
    {
      dim: "canal",
      key: "midia_paga",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 246120,
        },
        {
          event: "view_item",
          count: 116481,
        },
        {
          event: "add_to_cart",
          count: 15434,
        },
        {
          event: "begin_checkout",
          count: 4786,
        },
        {
          event: "purchase",
          count: 2324,
        },
        {
          event: "view_item_list",
          count: 132789,
        },
        {
          event: "select_item",
          count: 56602,
        },
        {
          event: "view_promotion",
          count: 168906,
        },
        {
          event: "select_promotion",
          count: 13636,
        },
        {
          event: "view_cart",
          count: 13896,
        },
        {
          event: "add_shipping_info",
          count: 4232,
        },
        {
          event: "add_payment_info",
          count: 4161,
        },
      ],
    },
    {
      dim: "canal",
      key: "outros",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 142848,
        },
        {
          event: "view_item",
          count: 104088,
        },
        {
          event: "add_to_cart",
          count: 28459,
        },
        {
          event: "begin_checkout",
          count: 8577,
        },
        {
          event: "purchase",
          count: 3369,
        },
        {
          event: "view_item_list",
          count: 60547,
        },
        {
          event: "select_item",
          count: 26070,
        },
        {
          event: "view_promotion",
          count: 115026,
        },
        {
          event: "select_promotion",
          count: 11974,
        },
        {
          event: "view_cart",
          count: 25702,
        },
        {
          event: "add_shipping_info",
          count: 7716,
        },
        {
          event: "add_payment_info",
          count: 7477,
        },
      ],
    },
    {
      dim: "canal",
      key: "referencia",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 3051,
        },
        {
          event: "view_item",
          count: 1409,
        },
        {
          event: "add_to_cart",
          count: 254,
        },
        {
          event: "begin_checkout",
          count: 77,
        },
        {
          event: "purchase",
          count: 31,
        },
        {
          event: "view_item_list",
          count: 1158,
        },
        {
          event: "select_item",
          count: 331,
        },
        {
          event: "view_promotion",
          count: 1970,
        },
        {
          event: "select_promotion",
          count: 178,
        },
        {
          event: "view_cart",
          count: 233,
        },
        {
          event: "add_shipping_info",
          count: 67,
        },
        {
          event: "add_payment_info",
          count: 68,
        },
      ],
    },
    {
      dim: "canal",
      key: "social",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 70510,
        },
        {
          event: "view_item",
          count: 34403,
        },
        {
          event: "add_to_cart",
          count: 8249,
        },
        {
          event: "begin_checkout",
          count: 2170,
        },
        {
          event: "purchase",
          count: 851,
        },
        {
          event: "view_item_list",
          count: 33338,
        },
        {
          event: "select_item",
          count: 15310,
        },
        {
          event: "view_promotion",
          count: 58692,
        },
        {
          event: "select_promotion",
          count: 12710,
        },
        {
          event: "view_cart",
          count: 7437,
        },
        {
          event: "add_shipping_info",
          count: 1961,
        },
        {
          event: "add_payment_info",
          count: 1897,
        },
      ],
    },
    {
      dim: "canal",
      key: "social_pago",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 687653,
        },
        {
          event: "view_item",
          count: 521785,
        },
        {
          event: "add_to_cart",
          count: 21586,
        },
        {
          event: "begin_checkout",
          count: 4872,
        },
        {
          event: "purchase",
          count: 2002,
        },
        {
          event: "view_item_list",
          count: 134288,
        },
        {
          event: "select_item",
          count: 43588,
        },
        {
          event: "view_promotion",
          count: 538506,
        },
        {
          event: "select_promotion",
          count: 20138,
        },
        {
          event: "view_cart",
          count: 17332,
        },
        {
          event: "add_shipping_info",
          count: 4323,
        },
        {
          event: "add_payment_info",
          count: 4242,
        },
      ],
    },
    {
      dim: "visitante",
      key: "nova",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 189674,
        },
        {
          event: "view_item",
          count: 45679,
        },
        {
          event: "add_to_cart",
          count: 9096,
        },
        {
          event: "begin_checkout",
          count: 3470,
        },
        {
          event: "purchase",
          count: 1802,
        },
        {
          event: "view_item_list",
          count: 116668,
        },
        {
          event: "select_item",
          count: 18318,
        },
        {
          event: "view_promotion",
          count: 154502,
        },
        {
          event: "select_promotion",
          count: 8589,
        },
        {
          event: "view_cart",
          count: 6934,
        },
        {
          event: "add_shipping_info",
          count: 2959,
        },
        {
          event: "add_payment_info",
          count: 2910,
        },
      ],
    },
    {
      dim: "visitante",
      key: "recorrente",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 42634,
        },
        {
          event: "view_item",
          count: 30446,
        },
        {
          event: "add_to_cart",
          count: 10569,
        },
        {
          event: "begin_checkout",
          count: 4491,
        },
        {
          event: "purchase",
          count: 2148,
        },
        {
          event: "view_item_list",
          count: 35012,
        },
        {
          event: "select_item",
          count: 17027,
        },
        {
          event: "view_promotion",
          count: 36617,
        },
        {
          event: "select_promotion",
          count: 9890,
        },
        {
          event: "view_cart",
          count: 10357,
        },
        {
          event: "add_shipping_info",
          count: 3910,
        },
        {
          event: "add_payment_info",
          count: 3695,
        },
      ],
    },
    {
      dim: "visitante",
      key: "sem_dado",
      platform: "web_desktop",
      steps: [
        {
          event: "session_start",
          count: 287,
        },
        {
          event: "view_item",
          count: 451,
        },
        {
          event: "add_to_cart",
          count: 87,
        },
        {
          event: "begin_checkout",
          count: 34,
        },
        {
          event: "purchase",
          count: 22,
        },
        {
          event: "view_item_list",
          count: 1234,
        },
        {
          event: "select_item",
          count: 148,
        },
        {
          event: "view_promotion",
          count: 2318,
        },
        {
          event: "select_promotion",
          count: 108,
        },
        {
          event: "view_cart",
          count: 86,
        },
        {
          event: "add_shipping_info",
          count: 30,
        },
        {
          event: "add_payment_info",
          count: 28,
        },
      ],
    },
    {
      dim: "visitante",
      key: "nova",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 1134710,
        },
        {
          event: "view_item",
          count: 684090,
        },
        {
          event: "add_to_cart",
          count: 53258,
        },
        {
          event: "begin_checkout",
          count: 14666,
        },
        {
          event: "purchase",
          count: 6323,
        },
        {
          event: "view_item_list",
          count: 352274,
        },
        {
          event: "select_item",
          count: 120563,
        },
        {
          event: "view_promotion",
          count: 848001,
        },
        {
          event: "select_promotion",
          count: 47786,
        },
        {
          event: "view_cart",
          count: 47451,
        },
        {
          event: "add_shipping_info",
          count: 13010,
        },
        {
          event: "add_payment_info",
          count: 12782,
        },
      ],
    },
    {
      dim: "visitante",
      key: "recorrente",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 305046,
        },
        {
          event: "view_item",
          count: 217592,
        },
        {
          event: "add_to_cart",
          count: 37490,
        },
        {
          event: "begin_checkout",
          count: 12074,
        },
        {
          event: "purchase",
          count: 5197,
        },
        {
          event: "view_item_list",
          count: 135735,
        },
        {
          event: "select_item",
          count: 65684,
        },
        {
          event: "view_promotion",
          count: 239414,
        },
        {
          event: "select_promotion",
          count: 30698,
        },
        {
          event: "view_cart",
          count: 36922,
        },
        {
          event: "add_shipping_info",
          count: 10926,
        },
        {
          event: "add_payment_info",
          count: 10547,
        },
      ],
    },
    {
      dim: "visitante",
      key: "sem_dado",
      platform: "web_mobile",
      steps: [
        {
          event: "session_start",
          count: 2998,
        },
        {
          event: "view_item",
          count: 19217,
        },
        {
          event: "add_to_cart",
          count: 509,
        },
        {
          event: "begin_checkout",
          count: 161,
        },
        {
          event: "purchase",
          count: 58,
        },
        {
          event: "view_item_list",
          count: 9278,
        },
        {
          event: "select_item",
          count: 836,
        },
        {
          event: "view_promotion",
          count: 55004,
        },
        {
          event: "select_promotion",
          count: 523,
        },
        {
          event: "view_cart",
          count: 673,
        },
        {
          event: "add_shipping_info",
          count: 148,
        },
        {
          event: "add_payment_info",
          count: 134,
        },
      ],
    },
  ],
  pdp_behaviour: [
    {
      device: "mobile",
      views: 252748,
      avg_depth_pct: 68.5,
      avg_fold_pct: 8.8,
      active_seconds: 34.9,
      clicks: 553130,
      dead_clicks: 42292,
      reach: {
        p25: 77.2,
        p50: 68.7,
        p75: 63.1,
      },
      funnel: {
        visitors: 109338,
        viewed: 53964,
        carted: 14873,
      },
      sections: [],
    },
    {
      device: "desktop",
      views: 38562,
      avg_depth_pct: 78.5,
      avg_fold_pct: 9.1,
      active_seconds: 78.8,
      clicks: 86900,
      dead_clicks: 8309,
      reach: {
        p25: 82.7,
        p50: 77.2,
        p75: 73.5,
      },
      funnel: {
        visitors: 19986,
        viewed: 10250,
        carted: 4236,
      },
      sections: [],
    },
  ],
  products: [],
  captures: [],
  benchmark: [],
  gaps: [],
};
