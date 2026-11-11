// One stylesheet for the viewer, scoped under .sv-shell, injected once per document. Colors
// come from CSS variables so a host can theme the chrome (the paper stays white).
const CSS = `
.sv-shell{height:100%;min-height:0;display:flex;flex-direction:column}
.sv-root{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--sv-bg,#e9e9ec);-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y}
.sv-page{background:var(--sv-paper,#fff);max-width:100%;margin:0 auto;min-height:100%;padding-bottom:24px;box-sizing:border-box}
.sv-system{position:relative;overflow:hidden}
.sv-system svg{display:block}
.sv-bar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:5px 8px;box-sizing:border-box;background:var(--sv-chrome,#2b2f36);color:var(--sv-bar-fg,#e6e6e6);border-top:1px solid var(--sv-border,#1c1f24);font:13px system-ui,sans-serif}
.sv-bb-btn{min-width:30px;height:30px;flex:0 0 auto;padding:0 8px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;font:inherit;background:var(--sv-btn,#3a3f47);color:inherit;border:1px solid var(--sv-btn-border,#4a4f57);border-radius:5px;cursor:pointer}
.sv-bb-btn:hover{border-color:var(--sv-accent,#6e7bff)}
.sv-bb-btn:focus-visible,.sv-zoom:focus-visible{outline:2px solid var(--sv-accent,#6e7bff);outline-offset:1px}
.sv-bb-icon{padding:0;width:30px}
.sv-bb-grow{flex:1 1 auto;min-width:0}
.sv-zoom{flex:0 1 110px;width:110px;min-width:40px;accent-color:var(--sv-accent,#6e7bff)}
.sv-zoom-label{flex:0 0 auto;min-width:38px;text-align:right;font-variant-numeric:tabular-nums}
.sv-lroot{flex:1 1 auto;min-height:0;display:flex;align-items:center;overflow-x:auto;overflow-y:hidden;background:var(--sv-paper,#fff);touch-action:pan-x}
.sv-strip{display:flex;align-items:flex-start;position:relative;min-width:100%}
.sv-chunk{flex:0 0 auto;position:relative;overflow:hidden;height:100%}
.sv-chunk-host{will-change:transform}
.sv-chunk svg{display:block}
.sv-cursor{position:absolute;top:0;bottom:0;left:0;width:3px;margin-left:-1px;background:var(--sv-play,#1a73e8);opacity:.55;border-radius:2px;pointer-events:none;z-index:1}
.sv-on path,.sv-on rect{fill:var(--sv-play,#1a73e8);stroke:var(--sv-play,#1a73e8)}
.sv-bb-play{min-width:40px}
.sv-bar{position:relative}
.sv-bar [hidden]{display:none}
.sv-seg{display:inline-flex;flex:0 0 auto}
.sv-seg .sv-bb-btn{border-radius:0;margin-left:-1px}
.sv-seg .sv-bb-btn:first-child{border-radius:5px 0 0 5px;margin-left:0}
.sv-seg .sv-bb-btn:last-child{border-radius:0 5px 5px 0}
.sv-bb-btn.is-on,.sv-bb-btn[aria-pressed="true"]{background:var(--sv-accent,#6e7bff);border-color:var(--sv-accent,#6e7bff);color:#fff}
.sv-keys{display:block;width:100%;flex:0 0 auto;height:clamp(56px,14vh,110px)}
.sv-keys-big{height:clamp(70px,20%,150px)}
.sv-kbd{flex:0 0 auto;border-top:1px solid var(--sv-border,#1c1f24)}
.sv-falls{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:#121418}
.sv-fall{flex:1 1 auto;min-height:0;width:100%;display:block}
.sv-bb-speed{font-variant-numeric:tabular-nums;min-width:52px}
.sv-pop{position:absolute;bottom:calc(100% + 6px);left:8px;z-index:3;padding:10px 12px;background:var(--sv-chrome,#2b2f36);border:1px solid var(--sv-btn-border,#4a4f57);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.sv-pop input{width:180px;accent-color:var(--sv-accent,#6e7bff)}
.sv-bar-end{display:contents}
.sv-reading .sv-bar-end{display:none}
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
