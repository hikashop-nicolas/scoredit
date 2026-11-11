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
.sv-edit{flex:0 0 auto;display:flex;flex-direction:column;gap:4px;padding:5px 8px;background:var(--sv-chrome,#2b2f36);color:var(--sv-bar-fg,#e6e6e6);border-top:1px solid var(--sv-border,#1c1f24);font:13px system-ui,sans-serif}
.sv-edit[hidden],.sv-pitch-strip[hidden]{display:none}
.sv-pal-row{display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
.sv-pal-row .sv-bb-btn{min-width:38px;min-height:38px;justify-content:center}
.sv-pal-row .sv-bb-btn:disabled{opacity:.35}
.sv-pal-done{margin-left:auto}
.sv-glyph{font-size:20px;line-height:1;font-family:"Noto Music","Segoe UI Symbol",system-ui,sans-serif}
.sv-voice{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;font-weight:600;font-size:12px}
.sv-voice-1{background:#1a73e8}.sv-voice-2{background:#188038}.sv-voice-3{background:#e8710a}.sv-voice-4{background:#a142f4}
.sv-pitch-strip{display:flex;align-items:stretch;gap:4px;height:72px;flex:0 0 auto}
.sv-strip-keys{display:block;flex:1 1 auto;min-width:0;height:100%;touch-action:none;cursor:pointer}
.sv-strip-nav{min-width:30px}
.sv-loupe{position:fixed;z-index:20;transform:translate(-50%,calc(-100% - 36px));padding:6px 12px;border-radius:10px;background:var(--sv-chrome,#2b2f36);color:#fff;font:600 22px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none}
.sv-loupe[hidden]{display:none}
.sv-shell:focus{outline:none}
.sv-root.sv-inputting{touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.sv-caret{position:absolute;left:0;width:2px;margin-left:-1px;background:var(--sv-caret,#e8710a);border-radius:1px;pointer-events:none;z-index:2;animation:sv-blink 1s steps(2,start) infinite}
@keyframes sv-blink{to{opacity:.25}}
@media (prefers-reduced-motion:reduce){.sv-caret{animation:none}}
.sv-sel path,.sv-sel ellipse{fill:var(--sv-caret,#e8710a)!important;stroke:var(--sv-caret,#e8710a)!important}
.sv-cursor{position:absolute;top:0;bottom:0;left:0;width:3px;margin-left:-1px;background:var(--sv-play,#1a73e8);opacity:.55;border-radius:2px;pointer-events:none;z-index:1}
.sv-on path,.sv-on rect{fill:var(--sv-play,#1a73e8);stroke:var(--sv-play,#1a73e8)}
.sv-bb-play{min-width:40px}
.sv-bb-tab{width:auto;padding:0 6px}
.sv-tab-label{font:600 10px/1 system-ui,sans-serif;letter-spacing:.06em}
.sv-bar{position:relative}
.sv-bar [hidden],.sv-bar[hidden]{display:none}
.sv-seg{display:inline-flex;flex:0 0 auto}
.sv-seg .sv-bb-btn{border-radius:0;margin-left:-1px}
.sv-seg .sv-bb-btn:first-child{border-radius:5px 0 0 5px;margin-left:0}
.sv-seg .sv-bb-btn:last-child{border-radius:0 5px 5px 0}
.sv-bb-btn.is-on,.sv-bb-btn[aria-pressed="true"]{background:var(--sv-accent,#6e7bff);border-color:var(--sv-accent,#6e7bff);color:#fff}
.sv-keys{display:block;width:100%;flex:0 0 auto;height:clamp(56px,14vh,110px)}
.sv-frets{height:clamp(84px,18vh,150px)}
.sv-keys-big{height:clamp(70px,20%,150px)}
.sv-kbd{flex:0 0 auto;border-top:1px solid var(--sv-border,#1c1f24)}
.sv-falls{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:#121418}
.sv-fall{flex:1 1 auto;min-height:0;width:100%;display:block}
.sv-bb-speed{font-variant-numeric:tabular-nums;min-width:52px}
.sv-pop{position:absolute;bottom:calc(100% + 6px);left:8px;z-index:3;padding:10px 12px;background:var(--sv-chrome,#2b2f36);border:1px solid var(--sv-btn-border,#4a4f57);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.sv-pop input{width:180px;accent-color:var(--sv-accent,#6e7bff)}
.sv-pop-parts{left:auto;right:8px;max-height:min(60vh,420px);overflow-y:auto;display:flex;flex-direction:column;gap:2px;min-width:180px;max-width:calc(100% - 16px)}
.sv-pop-parts label{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-pop-parts input{width:auto;margin:0;flex:0 0 auto}
.sv-pop-parts .sv-all{border-bottom:1px solid var(--sv-btn-border,#4a4f57);margin-bottom:4px;padding-bottom:8px}
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
