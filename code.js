// A11y Sticky Checker — main thread
// フレーム単位でアクセシビリティをチェックし、指摘を付箋風カードとしてフレームの上下に貼ります。

var NOTE_KEY = 'a11yNoteFor';
var TARGET_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET'];
var INTERACTIVE_RE = /(button|btn|link|icon|tab|toggle|checkbox|radio|switch|chip|close|menu|ボタン|リンク|アイコン|タブ|トグル|チェック|ラジオ|スイッチ|閉じる|メニュー)/i;
var INTERACTIVE_TYPES = ['FRAME', 'INSTANCE', 'COMPONENT', 'GROUP'];
// 文字サイズの下限。ひらがな・カタカナ・漢字・全角記号・半角カナを1文字でも含むテキストは日本語として扱う
var MIN_FONT_JA = 16;
var MIN_FONT_EN = 14;
var JA_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

var FONT = { regular: { family: 'Inter', style: 'Regular' }, bold: { family: 'Inter', style: 'Bold' } };
var running = false;

figma.showUI(__html__, { width: 360, height: 600, themeColors: true });

(async function init() {
  var settings = (await figma.clientStorage.getAsync('settings')) || {};
  figma.ui.postMessage({ type: 'init', settings: settings });
  postSelection();
})();

figma.on('selectionchange', postSelection);

function getTargetFrames() {
  return figma.currentPage.selection.filter(function (n) {
    return TARGET_TYPES.indexOf(n.type) !== -1 && n.getPluginData(NOTE_KEY) === '';
  });
}

function postSelection() {
  var frames = getTargetFrames();
  figma.ui.postMessage({
    type: 'selection',
    count: frames.length,
    names: frames.slice(0, 3).map(function (f) { return f.name; })
  });
}

function progress(text) {
  figma.ui.postMessage({ type: 'progress', text: text });
}

// ---- UIとのやりとり（AI呼び出しはUI側で行う） ----
var pending = {};
var reqSeq = 0;
function askUI(payload) {
  return new Promise(function (resolve) {
    reqSeq += 1;
    var id = reqSeq;
    pending[id] = resolve;
    figma.ui.postMessage(Object.assign({ type: 'ai-request', reqId: id }, payload));
  });
}

figma.ui.onmessage = async function (msg) {
  if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync('settings', msg.settings);
  } else if (msg.type === 'ai-result') {
    var resolve = pending[msg.reqId];
    if (resolve) { delete pending[msg.reqId]; resolve(msg); }
  } else if (msg.type === 'run') {
    if (running) return;
    running = true;
    try { await run(msg.options); }
    catch (e) { figma.notify('エラー：' + (e && e.message ? e.message : e), { error: true }); }
    finally { running = false; figma.ui.postMessage({ type: 'done' }); }
  } else if (msg.type === 'clear') {
    var notes = figma.currentPage.findChildren(function (n) { return n.getPluginData(NOTE_KEY) !== ''; });
    notes.forEach(function (n) { n.remove(); });
    figma.notify(notes.length + '件の付箋グループを削除しました');
  }
};

// ---- メイン処理 ----
async function run(opts) {
  var frames = getTargetFrames();
  if (!frames.length) { figma.notify('チェックしたいフレームを選択してください'); return; }
  await loadFonts();

  var total = 0;
  for (var i = 0; i < frames.length; i++) {
    var frame = frames[i];
    var head = '(' + (i + 1) + '/' + frames.length + ') 「' + frame.name + '」';
    progress(head + 'を計測しています');
    var logic = runLogicChecks(frame);

    var aiIssues = [];
    var aiError = null;
    if (opts.useAI) {
      progress(head + 'をAIが確認しています');
      try {
        var image = await exportFrame(frame);
        var res = await askUI({
          frameName: frame.name,
          image: image,
          outline: buildOutline(frame),
          logicSummary: logic.issues.map(function (x) { return x.title + '（' + x.layers.join(', ') + '）'; })
        });
        if (res.error) aiError = res.error;
        else aiIssues = (res.issues || []).map(normalizeAIIssue);
      } catch (e) {
        aiError = String(e && e.message ? e.message : e);
      }
    }

    var issues = logic.issues.concat(aiIssues);
    total += issues.length;
    placeNotes(frame, issues, {
      position: opts.position,
      aiError: aiError,
      uncertainCount: logic.uncertainCount
    });
  }
  progress('完了しました：' + frames.length + 'フレーム／' + total + '件の指摘');
  figma.notify('チェック完了：' + total + '件の指摘');
}

// ---- ロジックチェック ----
function runLogicChecks(frame) {
  var painted = [];           // 描画順に並んだ塗りの記録
  var groups = {};            // 同じ内容の指摘をまとめる
  var order = [];
  var uncertainCount = 0;

  function addIssue(key, base, layerName) {
    if (!groups[key]) { groups[key] = Object.assign({ layers: [] }, base); order.push(key); }
    if (groups[key].layers.indexOf(layerName) === -1) groups[key].layers.push(layerName);
  }

  function recordFills(node, op) {
    if (!('fills' in node) || !Array.isArray(node.fills)) return;
    var box = node.absoluteBoundingBox;
    if (!box) return;
    node.fills.forEach(function (p) {
      if (p.visible === false) return;
      var a = (p.opacity == null ? 1 : p.opacity) * op;
      if (p.type === 'SOLID') painted.push({ box: box, solid: true, color: p.color, alpha: a });
      else painted.push({ box: box, solid: false, alpha: a });
    });
  }

  function backgroundAt(x, y) {
    var c = { r: 1, g: 1, b: 1 };
    var uncertain = false;
    painted.forEach(function (p) {
      if (x < p.box.x || x > p.box.x + p.box.width || y < p.box.y || y > p.box.y + p.box.height) return;
      if (!p.solid) { if (p.alpha > 0.3) uncertain = true; return; }
      c = blend(p.color, c, p.alpha);
      if (p.alpha >= 0.99) uncertain = false;
    });
    return { color: c, uncertain: uncertain };
  }

  function checkText(node, op) {
    var box = node.absoluteBoundingBox;
    if (!box || node.characters.trim() === '') return;
    var segs;
    try { segs = node.getStyledTextSegments(['fontSize', 'fills', 'fontWeight']); }
    catch (e) { return; }
    var bg = backgroundAt(box.x + box.width / 2, box.y + box.height / 2);
    var worst = null;
    var smallest = null;
    // 1文字でも日本語があれば、英数字の部分も含めてテキスト全体を日本語の基準で判定する
    var ja = JA_RE.test(node.characters);
    var minFont = ja ? MIN_FONT_JA : MIN_FONT_EN;

    segs.forEach(function (s) {
      if (s.characters.trim() === '') return;
      var fill = null;
      for (var k = 0; k < s.fills.length; k++) {
        if (s.fills[k].type === 'SOLID' && s.fills[k].visible !== false) { fill = s.fills[k]; break; }
      }
      if (fill && !bg.uncertain) {
        var fg = blend(fill.color, bg.color, (fill.opacity == null ? 1 : fill.opacity) * op);
        var ratio = contrast(fg, bg.color);
        var large = s.fontSize >= 24 || (s.fontSize >= 18.66 && s.fontWeight >= 700);
        var need = large ? 3 : 4.5;
        if (ratio < need && (!worst || ratio / need < worst.ratio / worst.need)) {
          worst = { ratio: ratio, need: need, large: large, fg: fg, bg: bg.color };
        }
      }
      if (s.fontSize < minFont && (smallest === null || s.fontSize < smallest)) smallest = s.fontSize;
    });

    if (bg.uncertain) uncertainCount += 1;

    if (worst) {
      var fgHex = toHex(worst.fg), bgHex = toHex(worst.bg);
      var sug = suggestColor(worst.fg, worst.bg, worst.need);
      addIssue('contrast:' + fgHex + bgHex + worst.need, {
        source: 'logic', severity: 'high',
        title: 'テキストのコントラスト不足',
        wcag: '1.4.3', level: 'AA',
        detail: '文字色 ' + fgHex + '／背景 ' + bgHex + ' のコントラスト比は ' + worst.ratio.toFixed(2) +
          ':1 です（基準は ' + worst.need + ':1 以上' + (worst.large ? '、大きい文字' : '') + '）。',
        suggestion: sug
          ? '文字色を ' + toHex(sug) + ' 程度にすると基準を満たします。'
          : '文字色か背景色を調整して ' + worst.need + ':1 以上にしてください。'
      }, node.name);
    }
    if (smallest !== null) {
      var lang = ja ? '日本語を含むテキスト' : '英数字だけのテキスト';
      addIssue('small:' + (ja ? 'ja:' : 'en:') + smallest, {
        source: 'logic', severity: 'low',
        title: '文字サイズが小さい',
        wcag: '1.4.4（参考）', level: '推奨',
        detail: lang + 'に ' + smallest + 'px の文字があります。WCAGに最小サイズの規定はありませんが、' +
          lang + 'は' + minFont + 'px未満だと読みにくくなりがちです。',
        suggestion: '日本語を含むテキストは16px以上、英数字だけのテキストは14px以上にしてください。'
      }, node.name);
    }
  }

  function checkTarget(node) {
    if (INTERACTIVE_TYPES.indexOf(node.type) === -1 || !INTERACTIVE_RE.test(node.name)) return false;
    var w = Math.round(node.width), h = Math.round(node.height);
    if (w < 24 || h < 24) {
      addIssue('target:' + node.name + w + 'x' + h, {
        source: 'logic', severity: 'medium',
        title: 'タップ領域が小さい',
        wcag: '2.5.8', level: 'AA',
        detail: 'レイヤー名から操作要素と推定した要素が ' + w + '×' + h + 'px です（基準は24×24px以上。周囲に十分な余白があれば例外になります）。',
        suggestion: '当たり判定を24×24px以上に広げてください。モバイルでは44×44pxが目安です。'
      }, node.name);
    }
    return true;
  }

  function walk(node, parentOp, insideTarget) {
    if (node.visible === false) return;
    var op = parentOp * (typeof node.opacity === 'number' ? node.opacity : 1);
    if (op <= 0.01) return;
    var nowInside = insideTarget;
    if (node.type === 'TEXT') {
      checkText(node, op);
    } else {
      recordFills(node, op);
      if (node !== frame && !insideTarget && checkTarget(node)) nowInside = true;
    }
    if ('children' in node) {
      node.children.forEach(function (c) { walk(c, op, nowInside); });
    }
  }

  walk(frame, 1, false);
  return {
    issues: order.map(function (k) { return groups[k]; }),
    uncertainCount: uncertainCount
  };
}

// ---- AI用の素材 ----
async function exportFrame(frame) {
  var maxSide = Math.max(frame.width, frame.height);
  var scale = Math.min(2, 1568 / maxSide);
  return frame.exportAsync({ format: 'JPG', constraint: { type: 'SCALE', value: scale } });
}

function buildOutline(frame) {
  var lines = [];
  var LIMIT = 250;
  function rec(n, depth) {
    if (lines.length >= LIMIT || n.visible === false) return;
    var line = new Array(depth + 1).join('  ') + '[' + n.type + '] ' + n.name;
    if (n.type === 'TEXT') line += ' "' + n.characters.replace(/\s+/g, ' ').slice(0, 60) + '"';
    line += ' (' + Math.round(n.width) + '×' + Math.round(n.height) + ')';
    lines.push(line);
    if ('children' in n && depth < 8) n.children.forEach(function (c) { rec(c, depth + 1); });
  }
  rec(frame, 0);
  if (lines.length >= LIMIT) lines.push('…（以下省略）');
  return lines.join('\n');
}

function normalizeAIIssue(x) {
  var sev = ['high', 'medium', 'low'].indexOf(x.severity) !== -1 ? x.severity : 'medium';
  return {
    source: 'ai', severity: sev,
    title: String(x.title || '要確認'),
    wcag: String(x.wcag || ''), level: String(x.level || ''),
    layers: x.layer ? [String(x.layer)] : [],
    detail: String(x.detail || ''),
    suggestion: String(x.suggestion || '')
  };
}

// ---- 付箋の配置 ----
var SEV = {
  high:   { fill: 'FFD3C7', label: '要対応' },
  medium: { fill: 'FFE59A', label: '要確認' },
  low:    { fill: 'FFF5BF', label: '推奨' },
  ok:     { fill: 'D4F2DA', label: 'OK' },
  info:   { fill: 'E2E7EF', label: 'お知らせ' }
};
var SEV_ORDER = { high: 0, medium: 1, low: 2 };
var INK = hexToRgb('2B2B2B');
var INK_SOFT = hexToRgb('5C5848');

async function loadFonts() {
  var candidates = [['Noto Sans JP', 'Regular', 'Bold'], ['Inter', 'Regular', 'Bold']];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    try {
      await figma.loadFontAsync({ family: c[0], style: c[1] });
      await figma.loadFontAsync({ family: c[0], style: c[2] });
      FONT = { regular: { family: c[0], style: c[1] }, bold: { family: c[0], style: c[2] } };
      return;
    } catch (e) { /* 次の候補へ */ }
  }
}

function makeText(chars, size, bold, color) {
  var t = figma.createText();
  t.fontName = bold ? FONT.bold : FONT.regular;
  t.fontSize = size;
  t.lineHeight = { unit: 'PERCENT', value: 150 };
  t.characters = chars;
  t.fills = [{ type: 'SOLID', color: color }];
  t.textAutoResize = 'HEIGHT';
  return t;
}

function appendFill(parent, child) {
  parent.appendChild(child);
  child.layoutSizingHorizontal = 'FILL';
}

function makeCard(issue) {
  var sev = SEV[issue.severity] || SEV.medium;
  var card = figma.createFrame();
  card.name = '付箋：' + issue.title;
  card.layoutMode = 'VERTICAL';
  card.primaryAxisSizingMode = 'AUTO';
  card.counterAxisSizingMode = 'FIXED';
  card.resize(260, 100);
  card.paddingTop = 14; card.paddingBottom = 16;
  card.paddingLeft = 16; card.paddingRight = 16;
  card.itemSpacing = 6;
  card.cornerRadius = 2;
  card.fills = [{ type: 'SOLID', color: hexToRgb(sev.fill) }];
  card.effects = [{
    type: 'DROP_SHADOW', color: { r: 0.3, g: 0.25, b: 0.1, a: 0.18 },
    offset: { x: 0, y: 3 }, radius: 6, spread: 0, visible: true, blendMode: 'NORMAL'
  }];

  var meta = sev.label;
  if (issue.wcag) meta += '｜WCAG ' + issue.wcag + (issue.level ? ' ' + issue.level : '');
  if (issue.source === 'ai') meta += '｜AI判定';
  appendFill(card, makeText(meta, 11, true, INK_SOFT));
  appendFill(card, makeText(issue.title, 15, true, INK));
  if (issue.layers && issue.layers.length) {
    var shown = issue.layers.slice(0, 3).join('、');
    if (issue.layers.length > 3) shown += ' ほか' + (issue.layers.length - 3) + '件';
    appendFill(card, makeText('該当：' + shown, 11, false, INK_SOFT));
  }
  if (issue.detail) appendFill(card, makeText(issue.detail, 12, false, INK));
  if (issue.suggestion) appendFill(card, makeText('改善案：' + issue.suggestion, 12, true, INK));
  return card;
}

function placeNotes(frame, issues, opts) {
  // 前回の付箋を削除
  figma.currentPage.findChildren(function (n) { return n.getPluginData(NOTE_KEY) === frame.id; })
    .forEach(function (n) { n.remove(); });

  var sorted = issues.slice().sort(function (a, b) {
    return (SEV_ORDER[a.severity] || 0) - (SEV_ORDER[b.severity] || 0);
  });

  var extra = [];
  if (opts.uncertainCount > 0) {
    extra.push({
      severity: 'info', title: '自動判定できなかったテキスト',
      detail: '背景が画像やグラデーションのため、' + opts.uncertainCount + '件のテキストはコントラストを計算できませんでした。',
      suggestion: '目視か、カラーピッカーで実際の色を確認してください。'
    });
  }
  if (opts.aiError) {
    extra.push({
      severity: 'info', title: 'AIチェックを実行できませんでした',
      detail: opts.aiError.slice(0, 160),
      suggestion: '選んだAIのAPIキーとモデル名を確認して、もう一度実行してください。'
    });
  }
  if (!sorted.length) {
    extra.unshift({
      severity: 'ok', title: '問題は見つかりませんでした',
      detail: 'キーボード操作や読み上げ順など、静的なデザインだけでは確認できない項目もあります。',
      suggestion: '実装後に実機やスクリーンリーダーでも確認しましょう。'
    });
  }

  var box = frame.absoluteBoundingBox;
  var wrap = figma.createFrame();
  wrap.name = 'A11yチェック｜' + frame.name;
  wrap.layoutMode = 'VERTICAL';
  wrap.primaryAxisSizingMode = 'AUTO';
  wrap.counterAxisSizingMode = 'FIXED';
  wrap.resize(Math.max(box.width, 560), 100);
  wrap.itemSpacing = 14;
  wrap.fills = [];
  wrap.clipsContent = false;
  figma.currentPage.appendChild(wrap);

  var d = new Date();
  var stamp = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
  appendFill(wrap, makeText('アクセシビリティチェック　' + sorted.length + '件（' + stamp + '）', 16, true, INK));

  var row = figma.createFrame();
  row.name = '付箋';
  row.layoutMode = 'HORIZONTAL';
  row.layoutWrap = 'WRAP';
  row.itemSpacing = 16;
  row.counterAxisSpacing = 16;
  row.fills = [];
  row.clipsContent = false;
  appendFill(wrap, row);
  row.layoutSizingVertical = 'HUG';

  sorted.concat(extra).forEach(function (issue) { row.appendChild(makeCard(issue)); });

  wrap.x = box.x;
  wrap.y = opts.position === 'above' ? box.y - wrap.height - 48 : box.y + box.height + 48;
  wrap.setPluginData(NOTE_KEY, frame.id);
}

// ---- 色計算 ----
function lum(c) {
  function f(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrast(a, b) {
  var l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function blend(top, bottom, a) {
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a) };
}
function suggestColor(fg, bg, need) {
  var target = lum(bg) > 0.18 ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 };
  for (var t = 0.02; t <= 1.001; t += 0.02) {
    var c = blend(target, fg, t);
    if (contrast(c, bg) >= need + 0.05) return c;
  }
  return null;
}
function toHex(c) {
  return '#' + [c.r, c.g, c.b].map(function (v) {
    var s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return s.length < 2 ? '0' + s : s;
  }).join('').toUpperCase();
}
function hexToRgb(h) {
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}
