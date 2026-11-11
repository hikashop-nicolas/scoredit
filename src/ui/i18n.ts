// scoredit's own strings, so the library is multilingual on its own. The locale comes from
// the browser's preferred languages (base language, first match), English otherwise;
// hosts may force one with setLocale().

export type Dict = Record<string, string>;

const en: Dict = { keysView: "Falling notes", keyboard: "Keyboard", speed: "Speed", play: "Play", pause: "Pause", pageView: "Page view", lineView: "Line view", zoom: "Zoom", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen" };
const fr: Dict = { keysView: "Notes qui tombent", keyboard: "Clavier", speed: "Vitesse", play: "Lecture", pause: "Pause", pageView: "Vue page", lineView: "Vue en ligne", zoom: "Zoom", fullscreen: "Plein écran", exitFullscreen: "Quitter le plein écran" };
const ja: Dict = { keysView: "落ちてくる音符", keyboard: "鍵盤", speed: "速度", play: "再生", pause: "一時停止", pageView: "ページ表示", lineView: "横一列表示", zoom: "ズーム", fullscreen: "全画面表示", exitFullscreen: "全画面表示を終了" };
const es: Dict = { keysView: "Notas que caen", keyboard: "Teclado", speed: "Velocidad", play: "Reproducir", pause: "Pausa", pageView: "Vista de página", lineView: "Vista en línea", zoom: "Zoom", fullscreen: "Pantalla completa", exitFullscreen: "Salir de pantalla completa" };
const de: Dict = { keysView: "Fallende Noten", keyboard: "Klaviatur", speed: "Tempo", play: "Abspielen", pause: "Pause", pageView: "Seitenansicht", lineView: "Zeilenansicht", zoom: "Zoom", fullscreen: "Vollbild", exitFullscreen: "Vollbild beenden" };
const pt: Dict = { keysView: "Notas caindo", keyboard: "Teclado", speed: "Velocidade", play: "Reproduzir", pause: "Pausar", pageView: "Vista de página", lineView: "Vista em linha", zoom: "Zoom", fullscreen: "Tela cheia", exitFullscreen: "Sair da tela cheia" };
const ru: Dict = { keysView: "Падающие ноты", keyboard: "Клавиатура", speed: "Скорость", play: "Воспроизвести", pause: "Пауза", pageView: "Постранично", lineView: "В одну строку", zoom: "Масштаб", fullscreen: "Во весь экран", exitFullscreen: "Выйти из полноэкранного режима" };
const zh: Dict = { keysView: "下落音符", keyboard: "键盘", speed: "速度", play: "播放", pause: "暂停", pageView: "页面视图", lineView: "单行视图", zoom: "缩放", fullscreen: "全屏", exitFullscreen: "退出全屏" };

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
