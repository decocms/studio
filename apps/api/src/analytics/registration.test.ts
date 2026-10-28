import { expect, test } from "bun:test";
import { siteDomains } from "./registration";

test("siteDomains covers the apex and www whichever one is given", () => {
  expect(siteDomains("loja.example.com")).toEqual([
    "loja.example.com",
    "www.loja.example.com",
  ]);
  expect(siteDomains("WWW.Loja.example.com")).toEqual([
    "loja.example.com",
    "www.loja.example.com",
  ]);
});
