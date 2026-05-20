// ── ANSI Escape Sequence → HTML Renderer ──
// Converts ANSI SGR color/style codes to inline-styled HTML spans.
// Strips cursor-movement, erase, and OSC sequences cleanly.
// No external dependencies — runs as a plain browser script.

(function () {
  'use strict';

  // Standard 16-color palette tuned for the GitHub dark theme
  var C16 = [
    '#21262d', // 0  black
    '#f85149', // 1  red
    '#3fb950', // 2  green
    '#d29922', // 3  yellow
    '#58a6ff', // 4  blue
    '#bc8cff', // 5  magenta
    '#39c5cf', // 6  cyan
    '#e6edf3', // 7  white
    '#6e7681', // 8  bright black (gray)
    '#ff7b72', // 9  bright red
    '#56d364', // 10 bright green
    '#e3b341', // 11 bright yellow
    '#79c0ff', // 12 bright blue
    '#d2a8ff', // 13 bright magenta
    '#56d4dd', // 14 bright cyan
    '#ffffff', // 15 bright white
  ];

  // Resolve a 256-color ANSI index to a CSS color string
  function c256(n) {
    n = n >>> 0;
    if (n < 16) return C16[n];
    if (n > 231) {
      var g = Math.round((n - 232) * 255 / 23);
      return 'rgb(' + g + ',' + g + ',' + g + ')';
    }
    n -= 16;
    var r = Math.floor(n / 36);
    var gv = Math.floor((n % 36) / 6);
    var b = n % 6;
    var v = function (x) { return x ? x * 40 + 55 : 0; };
    return 'rgb(' + v(r) + ',' + v(gv) + ',' + v(b) + ')';
  }

  // HTML-escape plain text
  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function isNum(n) {
    return typeof n === 'number' && !Number.isNaN(n);
  }

  function toSgrCodes(params) {
    if (!params) return [0];
    return String(params)
      .split(/[;:]/)
      .map(function (token) {
        if (token === '') return NaN;
        var n = Number(token);
        return Number.isFinite(n) ? n : NaN;
      });
  }

  function clampByte(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return Math.round(n);
  }

  // Main converter
  function ansiToHtml(raw) {
    if (!raw) return '';

    // Current SGR state
    var fg = null, bg = null;
    var bold = false, dim = false, italic = false;
    var under = false, strike = false, blink = false;

    var out = '';

    // Regex matches:
    //  group 1+2 → CSI sequence:  ESC [ <params> <final-byte>
    //  group 3   → OSC sequence:  ESC ] <data> (BEL or ST terminator)
    //  group 4   → any other ESC + single char
    var RE = /\x1b(?:\[([0-9;:<=>?]*)([A-Za-z@`])|\]([^\x07\x1b]*)(?:\x07|\x1b\\)|(.))/g;
    var last = 0;
    var m;

    function flush(text) {
      if (!text) return;
      var e = esc(text);
      if (!fg && !bg && !bold && !dim && !italic && !under && !strike && !blink) {
        out += e;
        return;
      }
      var style = '';
      if (fg)     style += 'color:'       + fg  + ';';
      if (bg)     style += 'background:'  + bg  + ';';
      if (bold)   style += 'font-weight:700;';
      if (dim)    style += 'opacity:.55;';
      if (italic) style += 'font-style:italic;';
      var textDecorations = [];
      if (under) textDecorations.push('underline');
      if (strike) textDecorations.push('line-through');
      if (textDecorations.length) style += 'text-decoration:' + textDecorations.join(' ') + ';';
      if (blink)  style += 'animation:ansi-blink 1s step-start infinite;';
      out += '<span style="' + style + '">' + e + '</span>';
    }

    while ((m = RE.exec(raw)) !== null) {
      if (m.index > last) flush(raw.slice(last, m.index));
      last = RE.lastIndex;

      var params = m[1];
      var cmd   = m[2];
      // m[3] = OSC data, m[4] = ESC + other → both stripped

      if (cmd === 'm') {
        // SGR — Select Graphic Rendition
        var codes = toSgrCodes(params);
        var i = 0;
        while (i < codes.length) {
          var c = codes[i];
          if (!isNum(c)) { i++; continue; }
          if      (c === 0)  { fg = null; bg = null; bold = dim = italic = under = strike = blink = false; }
          else if (c === 1)  bold   = true;
          else if (c === 21) bold   = false;
          else if (c === 2)  dim    = true;
          else if (c === 3)  italic = true;
          else if (c === 4)  under  = true;
          else if (c === 5 || c === 6) blink = true;
          else if (c === 9)  strike = true;
          else if (c === 22) { bold = false; dim = false; }
          else if (c === 23) italic = false;
          else if (c === 24) under  = false;
          else if (c === 25) blink  = false;
          else if (c === 29) strike = false;
          else if (c >= 30 && c <= 37) fg = C16[c - 30];
          else if (c === 38) {
            if (codes[i + 1] === 5 && isNum(codes[i + 2]) && i + 2 < codes.length) {
              fg = c256(codes[i + 2]); i += 2;
            } else if (codes[i + 1] === 2 && isNum(codes[i + 2]) && isNum(codes[i + 3]) && isNum(codes[i + 4]) && i + 4 < codes.length) {
              fg = 'rgb(' + clampByte(codes[i+2]) + ',' + clampByte(codes[i+3]) + ',' + clampByte(codes[i+4]) + ')'; i += 4;
            } else if (codes[i + 1] === 2 && !isNum(codes[i + 2]) && isNum(codes[i + 3]) && isNum(codes[i + 4]) && isNum(codes[i + 5]) && i + 5 < codes.length) {
              // 24-bit variant with an empty colorspace slot, e.g. 38:2::R:G:B
              fg = 'rgb(' + clampByte(codes[i+3]) + ',' + clampByte(codes[i+4]) + ',' + clampByte(codes[i+5]) + ')'; i += 5;
            }
          }
          else if (c === 39) fg = null;
          else if (c >= 40 && c <= 47) bg = C16[c - 40];
          else if (c === 48) {
            if (codes[i + 1] === 5 && isNum(codes[i + 2]) && i + 2 < codes.length) {
              bg = c256(codes[i + 2]); i += 2;
            } else if (codes[i + 1] === 2 && isNum(codes[i + 2]) && isNum(codes[i + 3]) && isNum(codes[i + 4]) && i + 4 < codes.length) {
              bg = 'rgb(' + clampByte(codes[i+2]) + ',' + clampByte(codes[i+3]) + ',' + clampByte(codes[i+4]) + ')'; i += 4;
            } else if (codes[i + 1] === 2 && !isNum(codes[i + 2]) && isNum(codes[i + 3]) && isNum(codes[i + 4]) && isNum(codes[i + 5]) && i + 5 < codes.length) {
              // 24-bit variant with an empty colorspace slot, e.g. 48:2::R:G:B
              bg = 'rgb(' + clampByte(codes[i+3]) + ',' + clampByte(codes[i+4]) + ',' + clampByte(codes[i+5]) + ')'; i += 5;
            }
          }
          else if (c === 49) bg = null;
          else if (c >= 90  && c <= 97)  fg = C16[c - 82];  // bright fg: 90-97 → C16[8-15]
          else if (c >= 100 && c <= 107) bg = C16[c - 92];  // bright bg: 100-107 → C16[8-15]
          i++;
        }
      }
      // All other CSI commands (cursor movement, erase, etc.) and OSC sequences are stripped
    }

    if (last < raw.length) flush(raw.slice(last));
    return out;
  }

  window.ansiToHtml = ansiToHtml;
}());
