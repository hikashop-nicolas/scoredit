// scoredit's own strings, so the library is multilingual on its own. The locale comes from
// the browser's preferred languages (base language, first match), English otherwise;
// hosts may force one with setLocale().

export type Dict = Record<string, string>;

const en: Dict = { triplet: "Triplet", edit: "Edit", noteInput: "Note input", insertMode: "Insert", dot: "Dot", rest: "Rest", tie: "Tie", sharp: "Sharp", flat: "Flat", natural: "Natural", voice: "Voice", deleteNote: "Delete", undo: "Undo", redo: "Redo", done: "Done", sixteenth: "Sixteenth note", eighth: "Eighth note", quarter: "Quarter note", half: "Half note", whole: "Whole note", lower: "Lower", higher: "Higher", parts: "Parts", allParts: "All", fretboard: "Fretboard", tablature: "Tablature", keysView: "Falling notes", keyboard: "Keyboard", speed: "Speed", play: "Play", pause: "Pause", pageView: "Page view", lineView: "Line view", zoom: "Zoom", fullscreen: "Fullscreen", exitFullscreen: "Exit fullscreen" };
const fr: Dict = { triplet: "Triolet", edit: "Modifier", noteInput: "Saisie de notes", insertMode: "Insérer", dot: "Point", rest: "Silence", tie: "Liaison", sharp: "Dièse", flat: "Bémol", natural: "Bécarre", voice: "Voix", deleteNote: "Supprimer", undo: "Annuler", redo: "Rétablir", done: "Terminé", sixteenth: "Double croche", eighth: "Croche", quarter: "Noire", half: "Blanche", whole: "Ronde", lower: "Plus grave", higher: "Plus aigu", parts: "Parties", allParts: "Toutes", fretboard: "Manche", tablature: "Tablature", keysView: "Notes qui tombent", keyboard: "Clavier", speed: "Vitesse", play: "Lecture", pause: "Pause", pageView: "Vue page", lineView: "Vue en ligne", zoom: "Zoom", fullscreen: "Plein écran", exitFullscreen: "Quitter le plein écran" };
const ja: Dict = { triplet: "3連符", edit: "編集", noteInput: "音符入力", insertMode: "挿入", dot: "付点", rest: "休符", tie: "タイ", sharp: "シャープ", flat: "フラット", natural: "ナチュラル", voice: "声部", deleteNote: "削除", undo: "元に戻す", redo: "やり直し", done: "完了", sixteenth: "16分音符", eighth: "8分音符", quarter: "4分音符", half: "2分音符", whole: "全音符", lower: "低く", higher: "高く", parts: "パート", allParts: "すべて", fretboard: "指板", tablature: "タブ譜", keysView: "落ちてくる音符", keyboard: "鍵盤", speed: "速度", play: "再生", pause: "一時停止", pageView: "ページ表示", lineView: "横一列表示", zoom: "ズーム", fullscreen: "全画面表示", exitFullscreen: "全画面表示を終了" };
const es: Dict = { triplet: "Tresillo", edit: "Editar", noteInput: "Entrada de notas", insertMode: "Insertar", dot: "Puntillo", rest: "Silencio", tie: "Ligadura", sharp: "Sostenido", flat: "Bemol", natural: "Becuadro", voice: "Voz", deleteNote: "Eliminar", undo: "Deshacer", redo: "Rehacer", done: "Listo", sixteenth: "Semicorchea", eighth: "Corchea", quarter: "Negra", half: "Blanca", whole: "Redonda", lower: "Más grave", higher: "Más agudo", parts: "Partes", allParts: "Todas", fretboard: "Diapasón", tablature: "Tablatura", keysView: "Notas que caen", keyboard: "Teclado", speed: "Velocidad", play: "Reproducir", pause: "Pausa", pageView: "Vista de página", lineView: "Vista en línea", zoom: "Zoom", fullscreen: "Pantalla completa", exitFullscreen: "Salir de pantalla completa" };
const de: Dict = { triplet: "Triole", edit: "Bearbeiten", noteInput: "Noteneingabe", insertMode: "Einfügen", dot: "Punkt", rest: "Pause", tie: "Haltebogen", sharp: "Kreuz", flat: "Be", natural: "Auflösungszeichen", voice: "Stimme", deleteNote: "Löschen", undo: "Rückgängig", redo: "Wiederholen", done: "Fertig", sixteenth: "Sechzehntelnote", eighth: "Achtelnote", quarter: "Viertelnote", half: "Halbe Note", whole: "Ganze Note", lower: "Tiefer", higher: "Höher", parts: "Stimmen", allParts: "Alle", fretboard: "Griffbrett", tablature: "Tabulatur", keysView: "Fallende Noten", keyboard: "Klaviatur", speed: "Tempo", play: "Abspielen", pause: "Pause", pageView: "Seitenansicht", lineView: "Zeilenansicht", zoom: "Zoom", fullscreen: "Vollbild", exitFullscreen: "Vollbild beenden" };
const pt: Dict = { triplet: "Tercina", edit: "Editar", noteInput: "Entrada de notas", insertMode: "Inserir", dot: "Ponto", rest: "Pausa", tie: "Ligadura", sharp: "Sustenido", flat: "Bemol", natural: "Bequadro", voice: "Voz", deleteNote: "Excluir", undo: "Desfazer", redo: "Refazer", done: "Concluir", sixteenth: "Semicolcheia", eighth: "Colcheia", quarter: "Semínima", half: "Mínima", whole: "Semibreve", lower: "Mais grave", higher: "Mais agudo", parts: "Partes", allParts: "Todas", fretboard: "Braço", tablature: "Tablatura", keysView: "Notas caindo", keyboard: "Teclado", speed: "Velocidade", play: "Reproduzir", pause: "Pausar", pageView: "Vista de página", lineView: "Vista em linha", zoom: "Zoom", fullscreen: "Tela cheia", exitFullscreen: "Sair da tela cheia" };
const ru: Dict = { triplet: "Триоль", edit: "Редактировать", noteInput: "Ввод нот", insertMode: "Вставка", dot: "Точка", rest: "Пауза", tie: "Лига", sharp: "Диез", flat: "Бемоль", natural: "Бекар", voice: "Голос", deleteNote: "Удалить", undo: "Отменить", redo: "Повторить", done: "Готово", sixteenth: "Шестнадцатая", eighth: "Восьмая", quarter: "Четвертная", half: "Половинная", whole: "Целая", lower: "Ниже", higher: "Выше", parts: "Партии", allParts: "Все", fretboard: "Гриф", tablature: "Табулатура", keysView: "Падающие ноты", keyboard: "Клавиатура", speed: "Скорость", play: "Воспроизвести", pause: "Пауза", pageView: "Постранично", lineView: "В одну строку", zoom: "Масштаб", fullscreen: "Во весь экран", exitFullscreen: "Выйти из полноэкранного режима" };
const zh: Dict = { triplet: "三连音", edit: "编辑", noteInput: "音符输入", insertMode: "插入", dot: "附点", rest: "休止符", tie: "连音线", sharp: "升号", flat: "降号", natural: "还原号", voice: "声部", deleteNote: "删除", undo: "撤销", redo: "重做", done: "完成", sixteenth: "十六分音符", eighth: "八分音符", quarter: "四分音符", half: "二分音符", whole: "全音符", lower: "更低", higher: "更高", parts: "声部", allParts: "全部", fretboard: "指板", tablature: "六线谱", keysView: "下落音符", keyboard: "键盘", speed: "速度", play: "播放", pause: "暂停", pageView: "页面视图", lineView: "单行视图", zoom: "缩放", fullscreen: "全屏", exitFullscreen: "退出全屏" };

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
