export const DEFAULT_LOGO =
  "https://assets.decocache.com/decocms/bc2ca488-2bae-4aac-8d3e-ead262dad764/agent.png";

/** OpenRouter icon URL */
const OPENROUTER_ICON_URL =
  "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg";

/** Anthropic icon URL */
const ANTHROPIC_ICON_URL =
  "https://assets.decocache.com/decocms/4fa4f3ed-1bf3-4e5a-8d05-4f3787df5966/anthropic-icon-tdvkiqisswbrmtkiygb0ia.webp";

export function getProviderLogo(model: {
  providerId: string;
  modelId: string;
}): string {
  const upstreamProvider = model.modelId.includes("/")
    ? model.modelId.split("/")[0]
    : null;
  return (
    (upstreamProvider && PROVIDER_LOGOS[upstreamProvider]) ||
    PROVIDER_LOGOS[model.providerId] ||
    DEFAULT_LOGO
  );
}

export const PROVIDER_LOGOS: Record<string, string> = {
  "aion-labs":
    "https://assets.decocache.com/decocms/6da18da8-0160-4b85-8bca-84eefffebe12/images-(6).png",
  ai21: "https://assets.decocache.com/decocms/5d8388e9-027b-4b23-b816-90cee1cd28ad/images-(5).png",
  alfredpros:
    "https://assets.decocache.com/decocms/76eaa620-ce73-43d6-8817-272c1d498b53/images-(19).png",
  alibaba:
    "https://assets.decocache.com/decocms/4d113b13-5412-4d3b-96ec-3c2e7c1f7a5f/images-(8).png",
  allenai:
    "https://assets.decocache.com/decocms/21d6071a-e0da-4919-9f35-902b1d0b85b8/allen.png",
  alpindale:
    "https://assets.decocache.com/decocms/76eaa620-ce73-43d6-8817-272c1d498b53/images-(19).png",
  amazon:
    "https://assets.decocache.com/decocms/31e7b260-6cf0-4753-bb32-bd062b15c5f1/Amazon_icon.png",
  anthropic: ANTHROPIC_ICON_URL,
  "anthracite-org": DEFAULT_LOGO,
  "arcee-ai":
    "https://assets.decocache.com/decocms/ee325839-6acc-48dc-8cf7-8bab74698015/126496414.png",
  baidu:
    "https://assets.decocache.com/decocms/cf4c19f1-39b5-499e-87b7-e16dc5da2b50/images-(9).png",
  bytedance:
    "https://assets.decocache.com/decocms/1c111a26-8e1d-4a48-9d3c-fe9fb728af06/images-(18).png",
  "bytedance-seed":
    "https://assets.decocache.com/decocms/1c111a26-8e1d-4a48-9d3c-fe9fb728af06/images-(18).png",
  cognitivecomputations: DEFAULT_LOGO,
  cohere:
    "https://assets.decocache.com/decocms/c942091b-b3bf-4c46-af37-fc2c1086d9f7/cohere-color.png",
  deepcogito:
    "https://assets.decocache.com/decocms/4ee77a8f-a36a-4933-8cdf-d2e8676b88d8/images-(13).png",
  deepseek:
    "https://assets.decocache.com/decocms/3611e8ac-4cad-4b0e-a1f8-8f791288ce03/images-(1).png",
  eleutherai:
    "https://assets.decocache.com/decocms/76eaa620-ce73-43d6-8817-272c1d498b53/images-(19).png",
  essentialai:
    "https://assets.decocache.com/decocms/c5afc6de-1e41-457e-a6dd-91810d92541e/images-(1).jpeg",
  google:
    "https://assets.decocache.com/webdraw/17df85af-1578-42ef-ae07-4300de0d1723/gemini.svg",
  gryphe:
    "https://assets.decocache.com/decocms/a5503d3b-2056-47f2-a76c-611b7416bdc8/6798c7dccaaadd0a1318d66a_66f41d1fd146c3b0b9c76453_gryphe-logo.webp",
  "ibm-granite":
    "https://assets.decocache.com/decocms/2c50018d-6f70-472d-be30-65a5e8e249f0/images-(10).png",
  inflection: DEFAULT_LOGO,
  inception:
    "https://assets.decocache.com/decocms/ff9822b8-a914-482b-bd7d-b0e46b9d5a56/images-(6).jpeg",
  kwaipilot:
    "https://assets.decocache.com/decocms/cd576e1d-1184-45ba-8162-cf2bd06d684f/images-(14).png",
  liquid: DEFAULT_LOGO,
  mancer:
    "https://assets.decocache.com/decocms/79762356-a0c5-4546-b268-ad4a0b51db51/Screenshot-2026-01-08-at-18.49.42.png",
  meituan: DEFAULT_LOGO,
  "meta-llama":
    "https://assets.decocache.com/decocms/56421cb3-488c-4cc3-83a5-16d9a303850e/images-(11).png",
  microsoft:
    "https://assets.decocache.com/decocms/0e352a51-4ea5-4f35-802e-fd82bf266683/images-(12).png",
  minimax:
    "https://assets.decocache.com/decocms/f362cc4f-7ccc-4317-afda-92e6f348fdfd/images-(2).png",
  mistralai:
    "https://assets.decocache.com/decocms/73ab9971-bbbc-40dc-99a3-5fddd9a0f340/images-(3).png",
  morph: DEFAULT_LOGO,
  moonshotai:
    "https://assets.decocache.com/decocms/b8abfea7-e8b4-4b72-b653-fdf11c9e3b66/moonshot.png",
  neversleep: DEFAULT_LOGO,
  "nex-agi":
    "https://assets.decocache.com/decocms/d2ada265-160d-4959-981d-e90210d71713/241570229.jpeg",
  nousresearch:
    "https://assets.decocache.com/decocms/496acb3d-9b5d-4759-b764-16c9ca7eb6b2/nousresearch.png",
  nvidia:
    "https://assets.decocache.com/decocms/ecca3238-fa79-4648-bb55-738f13a4293f/nvidia-7.svg",
  opengvlab:
    "https://assets.decocache.com/decocms/fb2d0c32-85f1-410a-87f4-9731dfafd248/images-(2).jpeg",
  openai:
    "https://assets.decocache.com/webdraw/15dc381c-23b4-4f6b-9ceb-9690f77a7cf5/openai.svg",
  openrouter: OPENROUTER_ICON_URL,
  perplexity:
    "https://assets.decocache.com/decocms/3a134746-f370-4089-a3c9-fe545be0441c/images-(15).png",
  "prime-intellect": DEFAULT_LOGO,
  qwen: "https://assets.decocache.com/decocms/ab94208c-4439-4aec-a06c-c51747120e43/Qwen_logo.svg.png",
  raifle: DEFAULT_LOGO,
  relace:
    "https://assets.decocache.com/decocms/c5dbae73-3ce0-40ca-8433-c38783fb13a9/Screenshot-2026-01-08-at-18.52.09.png",
  sao10k:
    "https://assets.decocache.com/decocms/76eaa620-ce73-43d6-8817-272c1d498b53/images-(19).png",
  "stepfun-ai":
    "https://assets.decocache.com/decocms/8892b883-4905-444e-b554-648565dc7fab/images-(16).png",
  switchpoint:
    "https://assets.decocache.com/decocms/0319d595-e0dd-4d8e-a0a3-b20ff4cbddcb/images-(4).jpeg",
  tencent:
    "https://assets.decocache.com/decocms/80f2f7bd-f9ea-4fcf-b89c-c58823a389ed/images-(3).jpeg",
  thedrummer:
    "https://assets.decocache.com/decocms/5c6c09fc-cf9d-43a1-a1c3-4a1ef367b824/images-(17).png",
  thudm: DEFAULT_LOGO,
  tngtech:
    "https://assets.decocache.com/decocms/5b5648ad-f858-4687-b67b-212cf186b62d/images-(7).png",
  undi95: DEFAULT_LOGO,
  xiaomi:
    "https://assets.decocache.com/decocms/2d7191b7-fc80-4867-a431-6d443d691cfc/images-(4).png",
  "x-ai":
    "https://assets.decocache.com/webdraw/7a8003ff-8f2d-4988-8693-3feb20e87eca/xai.svg",
  "z-ai":
    "https://assets.decocache.com/decocms/12a0877f-c978-4880-88d1-09097e606e2f/Z.ai_(company_logo).svg.png",
};
