// Offline interactions over the captured repository markup and catalog.
const products = [...document.querySelectorAll('a[href*="/products/"]')]
  .filter((a) => a.querySelector("h3"))
  .map((a, i) => ({
    node: a,
    name: a.querySelector("h3").textContent.trim(),
    id: `catalog-${i}`,
  }));
products.forEach((p) => {
  p.node.id = p.id;
});
const field = document.querySelector("[data-prepared-search] input");
const suggestions = document.querySelector("[data-search-results]");
if (field && suggestions) {
  field.form.addEventListener("submit", (e) => e.preventDefault());
  field.addEventListener("input", () => {
    suggestions.replaceChildren();
    const q = field.value.trim().toLocaleLowerCase();
    if (!q) return;
    const matches = products
      .filter((p) => p.name.toLocaleLowerCase().includes(q))
      .slice(0, 6);
    for (const p of matches) {
      const a = document.createElement("a");
      a.href = `#${p.id}`;
      a.textContent = p.name;
      a.style.cssText = "display:block;padding:10px 4px";
      suggestions.append(a);
    }
    if (!matches.length) suggestions.textContent = "No products found.";
  });
  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") suggestions.replaceChildren();
    if (e.key === "ArrowDown") {
      suggestions.querySelector("a")?.focus();
      e.preventDefault();
    }
  });
}
const heading = [...document.querySelectorAll("h2")].find((h) =>
  /featured/i.test(h.textContent),
);
if (heading) heading.id = "featured";
const countdown = document.querySelector("[data-countdown]");
if (countdown) {
  const end = Date.now() + 86400000;
  setInterval(() => {
    const left = Math.max(0, Math.floor((end - Date.now()) / 1000));
    countdown.textContent = [
      Math.floor(left / 3600),
      Math.floor((left % 3600) / 60),
      left % 60,
    ]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }, 1000);
}
// Keep navigation inside the captured page; the sandbox never calls checkout or customer accounts.
document.querySelectorAll("a").forEach((a) => {
  if (!a.getAttribute("href")?.startsWith("#"))
    a.setAttribute("href", "#featured");
});
document
  .querySelectorAll("form")
  .forEach((form) =>
    form.addEventListener("submit", (e) => e.preventDefault()),
  );
