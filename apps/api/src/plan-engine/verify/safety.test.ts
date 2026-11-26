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
  test("Deco analytics is tracking", () => {
    expect(
      isTrackingRequest("https://analytics.decocdn.com/_dq/a.js?k=x"),
    ).toBe(true);
  });

  test("the store itself is not", () => {
    expect(isTrackingRequest("https://www.loja.example/p")).toBe(false);
  });

  test("subdomain of the listed hosts is too", () => {
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

  test("facebook.com only on /tr", () => {
    expect(
      isTrackingRequest("https://www.facebook.com/tr?id=1&ev=PageView"),
    ).toBe(true);
    expect(isTrackingRequest("https://www.facebook.com/loja")).toBe(false);
  });

  test("a host that only ends similarly does not match", () => {
    expect(isTrackingRequest("https://notgoogle-analytics.com/x")).toBe(false);
  });

  test("invalid URL is not tracking", () => {
    expect(isTrackingRequest("data:image/png;base64,AAAA")).toBe(false);
    expect(isTrackingRequest("não é url")).toBe(false);
  });
});

describe("forbiddenReason", () => {
  test("add-to-bag button", () => {
    expect(
      forbiddenReason(facts({ text: "Adicionar à sacola", tag: "button" })),
    ).not.toBeNull();
  });

  test("type=submit", () => {
    expect(forbiddenReason(facts({ type: "submit" }))).not.toBeNull();
  });

  test("email field", () => {
    expect(forbiddenReason(facts({ inputType: "email" }))).not.toBeNull();
  });

  test("password field", () => {
    expect(forbiddenReason(facts({ inputType: "password" }))).not.toBeNull();
  });

  test("postal code field", () => {
    expect(
      forbiddenReason(
        facts({ tag: "input", inputType: "text", text: "Digite seu CEP" }),
      ),
    ).not.toBeNull();
  });

  test("text field that asks for an email", () => {
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

  test("type=image submits a form", () => {
    expect(
      forbiddenReason(
        facts({ tag: "input", type: "image", inputType: "image" }),
      ),
    ).not.toBeNull();
  });

  test("purchase text after 200 characters still counts", () => {
    expect(
      forbiddenReason(
        facts({ text: `${"descrição ".repeat(40)}Adicionar à sacola` }),
      ),
    ).not.toBeNull();
  });

  test("checkout", () => {
    expect(forbiddenReason(facts({ text: "Finalizar compra" }))).not.toBeNull();
  });

  test("sign in", () => {
    expect(forbiddenReason(facts({ text: "Entrar" }))).not.toBeNull();
  });

  test("link to the checkout", () => {
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

  test("product title is allowed", () => {
    expect(
      forbiddenReason(facts({ tag: "h1", text: "Relógio Feminino Prata" })),
    ).toBeNull();
  });

  test("link to another PDP is allowed", () => {
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
  test("no target, _self, _top and _parent stay in the tab", () => {
    for (const t of [null, "", " ", "_self", "_top", "_PARENT"]) {
      expect(opensNewTab(t)).toBe(false);
    }
  });

  test("_blank and any window name open another tab", () => {
    for (const t of ["_blank", "_BLANK", "nova", "produto", "_new"]) {
      expect(opensNewTab(t)).toBe(true);
    }
  });
});
