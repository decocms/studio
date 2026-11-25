import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createFileLinkRoutes } from "./file-links";

const app = new Hono().route("/f", createFileLinkRoutes());

async function location(path: string) {
  const res = await app.request(path);
  return { status: res.status, location: res.headers.get("location") };
}

describe("file links", () => {
  test("redirects a nested path to the read proxy", async () => {
    expect(await location("/f/acme/home/atlas/invoices-open.png")).toEqual({
      status: 302,
      location: "/api/acme/fs/home/read?path=atlas%2Finvoices-open.png",
    });
  });

  test("decodes encoded segments once", async () => {
    expect(
      await location("/f/acme/home/Relat%C3%B3rios/q1%20final.pdf"),
    ).toEqual({
      status: 302,
      location: "/api/acme/fs/home/read?path=Relat%C3%B3rios%2Fq1+final.pdf",
    });
  });

  test("404s without a file path", async () => {
    expect((await app.request("/f/acme/home")).status).toBe(404);
    expect((await app.request("/f/acme/home/")).status).toBe(404);
  });
});
