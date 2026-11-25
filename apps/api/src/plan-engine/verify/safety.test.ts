import { describe, expect, test } from "bun:test";
import {
  type ElementFacts,
  forbiddenReason,
  isTrackingRequest,
  opensNewTab,
} from "./safety.ts";

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({
  found: true,
  tag: "div",
  text: "",
  role: null,
  type: null,
  inLink: false,
  inButton: false,
  href: null,
  linkTarget: null,
  cursor: "auto",
  color: "#222222",
  parentColor: "#222222",
  textDecoration: "none",
  hasClickHandler: false,
  inForm: false,
  inputType: null,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  ...over,
});

describe("isTrackingRequest", () => {
  test("analytics da Deco é rastreio", () => {
    expect(
      isTrackingRequest("https://analytics.decocdn.com/_dq/a.js?k=x"),
    ).toBe(true);
  });

  test("a própria loja não é", () => {
    expect(isTrackingRequest("https://www.loja.example/p")).toBe(false);
  });

  test("subdomínio dos hosts listados também é", () => {
    expect(
      isTrackingRequest("https://www.google-analytics.com/g/collect?v=2"),
    ).toBe(true);
    expect(
      isTrackingRequest("https://www.googletagmanager.com/gtm.js?id=GTM-X"),
    ).toBe(true);
    expect(isTrackingRequest("https://d.lilstts.com/e")).toBe(true);
    expect(
      isTrackingRequest("https://connect.facebook.net/en_US/fbevents.js"),
    ).toBe(true);
  });

  test("facebook.com só no /tr", () => {
    expect(
      isTrackingRequest("https://www.facebook.com/tr?id=1&ev=PageView"),
    ).toBe(true);
    expect(isTrackingRequest("https://www.facebook.com/loja")).toBe(false);
  });

  test("host que só termina parecido não casa", () => {
    expect(isTrackingRequest("https://notgoogle-analytics.com/x")).toBe(false);
  });

  test("URL inválida não é rastreio", () => {
    expect(isTrackingRequest("data:image/png;base64,AAAA")).toBe(false);
    expect(isTrackingRequest("não é url")).toBe(false);
  });
});

describe("forbiddenReason", () => {
  test("botão de adicionar à sacola", () => {
    expect(
      forbiddenReason(facts({ text: "Adicionar à sacola", tag: "button" })),
    ).not.toBeNull();
  });

  test("type=submit", () => {
    expect(forbiddenReason(facts({ type: "submit" }))).not.toBeNull();
  });

  test("campo de e-mail", () => {
    expect(forbiddenReason(facts({ inputType: "email" }))).not.toBeNull();
  });

  test("campo de senha", () => {
    expect(forbiddenReason(facts({ inputType: "password" }))).not.toBeNull();
  });

  test("campo de CEP", () => {
    expect(
      forbiddenReason(
        facts({ tag: "input", inputType: "text", text: "Digite seu CEP" }),
      ),
    ).not.toBeNull();
  });

  test("campo de texto que pede e-mail", () => {
    expect(
      forbiddenReason(
        facts({ tag: "input", inputType: "text", text: "newsletter_email" }),
      ),
    ).not.toBeNull();
    expect(
      forbiddenReason(
        facts({ tag: "input", inputType: "text", text: "Seu e-mail" }),
      ),
    ).not.toBeNull();
  });

  test("type=image envia formulário", () => {
    expect(
      forbiddenReason(
        facts({ tag: "input", type: "image", inputType: "image" }),
      ),
    ).not.toBeNull();
  });

  test("texto de compra depois de 200 caracteres ainda conta", () => {
    expect(
      forbiddenReason(
        facts({ text: `${"descrição ".repeat(40)}Adicionar à sacola` }),
      ),
    ).not.toBeNull();
  });

  test("finalizar compra", () => {
    expect(forbiddenReason(facts({ text: "Finalizar compra" }))).not.toBeNull();
  });

  test("entrar", () => {
    expect(forbiddenReason(facts({ text: "Entrar" }))).not.toBeNull();
  });

  test("link pro checkout", () => {
    expect(
      forbiddenReason(
        facts({
          tag: "a",
          inLink: true,
          href: "https://loja.com/checkout/#/cart",
        }),
      ),
    ).not.toBeNull();
  });

  test("título do produto pode", () => {
    expect(
      forbiddenReason(facts({ tag: "h1", text: "Relógio Feminino Prata" })),
    ).toBeNull();
  });

  test("link pra outra PDP pode", () => {
    expect(
      forbiddenReason(
        facts({
          tag: "a",
          inLink: true,
          text: "Vestido Floral",
          href: "https://loja.com/vestido-floral/p",
        }),
      ),
    ).toBeNull();
  });
});

describe("opensNewTab", () => {
  test("sem target, _self, _top e _parent ficam na aba", () => {
    for (const t of [null, "", " ", "_self", "_top", "_PARENT"]) {
      expect(opensNewTab(t)).toBe(false);
    }
  });

  test("_blank e qualquer nome de janela abrem outra aba", () => {
    for (const t of ["_blank", "_BLANK", "nova", "produto", "_new"]) {
      expect(opensNewTab(t)).toBe(true);
    }
  });
});
