/**
 * O revisor independente: o último olhar antes de uma hipótese ir pro teste.
 *
 * Ele não é mais um agente que concorda: lê SÓ o dossiê (não o raciocínio
 * que gerou a hipótese) e responde a pergunta que os outros passos não fazem
 * — "que evidência mostra que isto explica o gap de conversão, e não só que o
 * componente é diferente?".
 *
 * O código aplica a resposta, e só pra baixo (mesma regra do juiz da
 * verificação: a última palavra nunca é do modelo):
 * - "nao": a hipótese volta de pronta pra relevância avaliada (não aprova);
 * - "parcial": a prioridade de teste cai 20%;
 * - "sim": nada muda.
 * Revisão que falha não mexe em nada e vira limite na tela.
 */

export interface HypothesisReview {
  explica_o_gap: "sim" | "parcial" | "nao";
  resposta: string;
  falhas: string[];
  reviewed_at: string;
}
