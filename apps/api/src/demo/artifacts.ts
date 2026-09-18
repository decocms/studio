import { recipes } from "./scenario";
import type { DemoRecipe } from "@decocms/shared/demo";

export function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
const style = `*{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#252c26;font:15px system-ui,sans-serif}a{color:inherit}button,input{font:inherit}button{cursor:pointer}header{display:flex;align-items:center;gap:32px;padding:28px 6%;border-bottom:1px solid #d9ddd5}.logo{font-family:Georgia,serif;font-size:34px;font-weight:bold;letter-spacing:-2px}nav{display:flex;gap:24px;margin-left:auto}main{padding:48px 6%;max-width:1440px;margin:auto}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#616d5c}h1{font:clamp(36px,5vw,72px)/1.04 Georgia,serif;max-width:690px;font-weight:normal;margin:22px 0}h2{font:32px Georgia,serif}.hero{background:#e7ecdf;padding:48px;border-radius:4px;margin-bottom:42px}.hero p{max-width:440px;line-height:1.7}.cta,button{background:#293c2a;color:white;border:0;border-radius:4px;padding:12px 20px;text-decoration:none;display:inline-block}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}.product{cursor:pointer}.product svg{width:100%;height:240px;background:#ecece6;border-radius:4px}.product h3{font-size:16px;margin-bottom:6px}.price{color:#626958}input{border:1px solid #bac4b7;padding:12px 16px;border-radius:5px;width:100%;background:white;color:#252c26}.search{position:relative;width:310px;margin-left:30px}#suggestions{position:absolute;z-index:2;background:white;box-shadow:0 10px 30px #0002;left:0;right:0}#suggestions a{display:block;padding:14px;text-decoration:none}#suggestions a:hover,#suggestions a:focus{background:#e7ecdf}.promo{text-align:center;background:#7646c6;color:white;padding:12px}.demo{padding:9px 6%;font-size:12px;background:#edf0e9;display:flex;gap:20px;align-items:center}.demo a:last-child{margin-left:auto}footer{padding:40px 6%;border-top:1px solid #d9ddd5;margin-top:40px;color:#6b7165}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;background:#edf0e9;line-height:1.7}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:24px}.removed{background:#fff0ed}.added{background:#e4f2e4}dialog{max-width:480px;border:0;padding:35px;border-radius:8px}dialog::backdrop{background:#0007}@media(max-width:760px){header{flex-wrap:wrap;gap:18px}.search{order:3;width:100%;margin:0}nav{gap:14px}.hero{padding:26px}.grid{grid-template-columns:repeat(2,1fr)}.comparison{grid-template-columns:1fr}}`;
const products = [
  {
    name: "Arc ceramic vase",
    price: "$48",
    color: "#be876c",
    shape:
      '<path d="M100 55h40v45c35 20 50 60 36 100H64c-14-40 1-80 36-100Z"/>',
  },
  {
    name: "Linen table lamp",
    price: "$120",
    color: "#c7b98e",
    shape:
      '<path d="M90 45h60l40 100H50Z"/><path d="M116 145h8v55h36v8H80v-8h36Z" fill="#7a674e"/>',
  },
  {
    name: "Everyday stoneware",
    price: "$36",
    color: "#72806a",
    shape:
      '<ellipse cx="120" cy="155" rx="85" ry="42"/><ellipse cx="120" cy="147" rx="78" ry="29" fill="#cbd2c3"/>',
  },
  {
    name: "Soft wool cushion",
    price: "$64",
    color: "#c99574",
    shape:
      '<path d="M50 70Q120 90 190 70Q170 130 190 200Q120 180 50 200Q70 130 50 70Z"/>',
  },
];
function shell(title: string, body: string, script = "", meta = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${meta}<style>${style}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}
export function storefront(
  recipe: DemoRecipe,
  before: boolean,
  boardUrl: string,
  published?: DemoRecipe[],
) {
  const active = published ?? (before ? [] : [recipe]);
  const search = active.includes("search");
  const promo = active.includes("promotion");
  return shell(
    "Forma · Everyday objects",
    `
    <div class="demo"><span>Demonstration · storefront-v1 · ${published ? "Published demonstration" : before ? "Before" : "Prepared result"}</span>${published ? "" : `<a href="?before=${before ? "0" : "1"}">${before ? "View result" : "Compare before"}</a>`}<a href="${escapeHtml(boardUrl)}">Back to Studio</a></div>
    ${promo ? '<div class="promo"><a href="#collection">The weekend edit · 20% off selected objects</a> · Ends in <span id="countdown">23:59:59</span></div>' : ""}
    <header><a class="logo" href="#">forma.</a>${search ? '<div class="search"><input id="search" type="search" aria-label="Search products" placeholder="Find your next favorite" aria-controls="suggestions"><div id="suggestions" role="region" aria-live="polite"></div></div>' : ""}<nav><a href="#collection">Shop</a><a href="#story">Our story</a><a href="#collection">${search ? "Bag (0)" : "Search"}</a></nav></header>
    <main><section class="hero" id="story"><span class="eyebrow">Objects with a little more meaning</span><h1>Make room for<br>the everyday.</h1><p>Thoughtful forms, natural textures and pieces you will reach for again and again. A quieter kind of collection.</p><a class="cta" href="#collection">Explore the collection ↗</a></section>
    <div id="collection"><span class="eyebrow">The considered collection</span><h2>Small things. Lasting favorites.</h2><div class="grid">${products.map((p, i) => `<article class="product" id="product-${i}"><a href="#product-${i}" data-product="${i}"><svg viewBox="0 0 240 240" role="img" aria-label="${p.name}"><ellipse cx="120" cy="213" rx="78" ry="8" fill="#0001"/><g fill="${p.color}">${p.shape}</g></svg><h3>${p.name}</h3></a><span class="price">${p.price}</span></article>`).join("")}</div></div></main>
    <footer>Forma · Thoughtful everyday objects. Synthetic catalog for demonstration.</footer><dialog id="product"><button id="close">Close</button><h2 id="product-name"></h2><p id="product-price"></p><p>A carefully considered piece for everyday living.</p><button id="bag">Add to bag</button><p id="bag-status" aria-live="polite"></p></dialog>`,
    `
const products=${JSON.stringify(products.map((p) => ({ name: p.name, price: p.price })))};
const dialog=document.getElementById('product');
function openProduct(i){document.getElementById('product-name').textContent=products[i].name;document.getElementById('product-price').textContent=products[i].price;document.getElementById('bag-status').textContent='';dialog.showModal()}
document.addEventListener('click',e=>{const link=e.target.closest('[data-product]');if(link){e.preventDefault();openProduct(Number(link.dataset.product))}});
document.getElementById('close').onclick=()=>dialog.close();document.getElementById('bag').onclick=()=>document.getElementById('bag-status').textContent='Added to your demonstration bag.';
const search=document.getElementById('search');if(search){search.oninput=()=>{const q=search.value.trim().toLowerCase();const matches=products.map((p,i)=>({...p,i})).filter(p=>p.name.toLowerCase().includes(q));document.getElementById('suggestions').innerHTML=q?matches.length?matches.map(p=>'<a href="#product-'+p.i+'" data-product="'+p.i+'">'+p.name+'</a>').join(''):'<p>No products found. Try “vase”.</p>':''};search.onkeydown=e=>{if(e.key==='ArrowDown'){document.querySelector('#suggestions a')?.focus();e.preventDefault()}if(e.key==='Escape'){document.getElementById('suggestions').textContent=''}}}
const countdown=document.getElementById('countdown');if(countdown){let left=86399;setInterval(()=>{left=Math.max(0,left-1);countdown.textContent=[Math.floor(left/3600),Math.floor(left%3600/60),left%60].map(n=>String(n).padStart(2,'0')).join(':')},1000)}
`,
    active.includes("diagnostic")
      ? '<meta name="description" content="Thoughtful everyday objects for your home. Explore the Forma collection.">'
      : "",
  );
}
export function changePage(
  recipe: DemoRecipe,
  previewUrl: string,
  boardUrl: string,
) {
  const data = recipes[recipe];
  return shell(
    data.title,
    `<div class="demo">Demonstration · prepared change<a href="${escapeHtml(boardUrl)}">Back to Studio</a></div><main><span class="eyebrow">storefront-v1 · Checks passed</span><h1>${escapeHtml(data.title)}</h1><p>${escapeHtml(data.result)}</p><p><a class="cta" href="${escapeHtml(previewUrl)}">Open preview ↗</a></p><div class="comparison"><section><h2>Before</h2><pre class="removed">${escapeHtml(data.before)}</pre></section><section><h2>After</h2><pre class="added">${escapeHtml(data.after)}</pre></section></div><p>This is a prepared demonstration change. Approve it from the task in Studio.</p></main>`,
  );
}
export function reportPage(boardUrl: string) {
  return shell(
    "Storefront diagnostic",
    `<div class="demo">Demonstration · curated diagnostic<a href="${escapeHtml(boardUrl)}">Back to Studio</a></div><main><span class="eyebrow">Forma · storefront-v1</span><h1>A clearer path<br>to your products.</h1><p>This report describes the prepared baseline used by the demonstration tasks.</p><div class="comparison"><section class="hero"><h2>Search discovery</h2><p>Search is hidden behind a header link. Add a visible field and product suggestions.</p></section><section class="hero"><h2>Homepage metadata</h2><p>The baseline has no meta description. The task “Add the missing homepage meta description” produces a matching diff and preview.</p></section></div><a class="cta" href="${escapeHtml(boardUrl)}">Open the prepared tasks ↗</a><p>Regenerating this diagnostic retains storefront-v1. It does not scan an external site.</p></main>`,
  );
}
