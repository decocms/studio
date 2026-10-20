import { createServer } from "node:http";

/** A third-party preview origin; Studio itself always runs unmodified over HTTP. */
export async function startPreviewSite() {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forma · About</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f4f0e9;color:#243026;font:16px system-ui,sans-serif}nav{display:flex;justify-content:space-between;padding:24px 7%;border-bottom:1px solid #d8d6ce}nav strong{font-size:24px;letter-spacing:-1px}nav span{font-size:12px;word-spacing:18px}main{padding:8% 10%}small{letter-spacing:3px;font-size:10px}h1{font:clamp(36px,6vw,76px)/1.08 Georgia,serif;max-width:700px;font-weight:400;margin:28px 0}p{max-width:370px;font-size:14px;line-height:1.8;color:#657064}.art{height:200px;border-radius:160px 160px 0 0;margin:35px 0;background:linear-gradient(130deg,#c3c6ac,#e5dcc9 60%,#acb9ab)}footer{padding:25px 10%;font-size:11px;border-top:1px solid #d8d6ce}
      </style></head><body><nav><strong>forma</strong><span>Collection About Journal</span></nav><main><small>THOUGHTFULLY MADE</small><h1>Made for everyday living.</h1><p>Simple objects, honest materials. A collection made to bring a little more calm to the places we call home.</p><div class="art"></div></main><footer>Forma — Preview fixture</footer></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Preview server did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
