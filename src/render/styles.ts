const CSS = `
.sv-root{height:100%;overflow:auto;scrollbar-gutter:stable;background:var(--sv-bg,#e9e9ec);-webkit-overflow-scrolling:touch}
.sv-page{background:var(--sv-paper,#fff);max-width:100%;margin:0 auto;min-height:100%;padding-bottom:24px;box-sizing:border-box}
.sv-system{position:relative;overflow:hidden}
.sv-system svg{display:block}
`;

let done = false;
export function injectStyles(): void {
  if (done || typeof document === "undefined") return;
  done = true;
  const s = document.createElement("style");
  s.dataset.scoredit = "";
  s.textContent = CSS;
  document.head.append(s);
}
