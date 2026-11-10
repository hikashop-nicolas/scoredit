// scoredit's own strings, so the library is multilingual on its own. The locale comes from
// the browser's preferred languages (base language, first match), English otherwise;
// hosts may force one with setLocale().

export type Dict = Record<string, string>;

const en: Dict = { zoom: "Zoom", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen" };
const fr: Dict = { zoom: "Zoom", fullscreen: "Plein écran", exitFullscreen: "Quitter le plein écran" };
const ja: Dict = { zoom: "ズーム", fullscreen: "全画面表示", exitFullscreen: "全画面表示を終了" };
const es: Dict = { zoom: "Zoom", fullscreen: "Pantalla completa", exitFullscreen: "Salir de pantalla completa" };
const de: Dict = { zoom: "Zoom", fullscreen: "Vollbild", exitFullscreen: "Vollbild beenden" };
const pt: Dict = { zoom: "Zoom", fullscreen: "Tela cheia", exitFullscreen: "Sair da tela cheia" };
const ru: Dict = { zoom: "Масштаб", fullscreen: "Во весь экран", exitFullscreen: "Выйти из полноэкранного режима" };
const zh: Dict = { zoom: "缩放", fullscreen: "全屏", exitFullscreen: "退出全屏" };

const LOCALES: Record<string, Dict> = { en, fr, ja, es, de, pt, ru, zh };

function detect(): Dict {
  const langs = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  for (const l of langs) {
    const base = (l || "").toLowerCase().split("-")[0];
    if (LOCALES[base]) return LOCALES[base];
  }
  return en;
}

let active: Dict = detect();

/** Forces a locale (e.g. "fr"); unknown codes fall back to English. */
export function setLocale(code: string): void {
  active = LOCALES[code] ?? en;
}

export function t(key: string): string {
  return active[key] ?? en[key] ?? key;
}
