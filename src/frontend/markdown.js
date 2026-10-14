/* ==========================================================================
 * 轻量 Markdown 渲染器（零依赖，离线可用）
 * 支持：代码块 + 复制按钮、行内代码、标题、无序/有序列表（含嵌套）、
 *      引用、分割线、加粗/斜体/删除线、链接、自动链接、换行
 * 对外暴露：window.renderMarkdown(src) -> html 字符串
 *          window.mdCodeStore             -> Map<ref, code>，供复制按钮取原文
 * ========================================================================== */
(function (global) {
  'use strict';

  /** 代码原文仓库：key 为 data-code-ref，避免把代码塞进 HTML 属性 */
  var codeStore = new Map();
  var codeSeq = 0;

  function stashCode(code) {
    if (codeStore.size > 400) codeStore.clear();
    var ref = 'md-code-' + ++codeSeq;
    codeStore.set(ref, code);
    return ref;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    var u = String(url == null ? '' : url).trim();
    // 只允许 http(s) / mailto / 锚点 / 站内相对路径，其余一律丢弃
    return /^(https?:\/\/|mailto:|#|\/|\.\/)/i.test(u) ? u.replace(/"/g, '%22') : '';
  }

  var PH = '\u0000';

  /** 行内语法 */
  function inline(text, store) {
    var s = escapeHtml(text);

    // 行内代码（先抽出，避免内部符号被后续规则误伤）
    s = s.replace(/`([^`\n]+)`/g, function (_, code) {
      store.push('<code class="inline-code">' + code + '</code>');
      return PH + (store.length - 1) + PH;
    });

    // 图片（退化为链接文本）
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, url) {
      var href = safeUrl(url.replace(/&amp;/g, '&'));
      return href ? '<a href="' + href + '" target="_blank" rel="noopener">' + (alt || '图片') + '</a>' : alt;
    });

    // 链接
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, label, url) {
      var href = safeUrl(url.replace(/&amp;/g, '&'));
      return href ? '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>' : label;
    });

    // 裸链接自动识别
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>&)]+)/g, function (_, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
    });

    // 加粗 / 斜体 / 删除线
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return s;
  }

  function codeBlockHtml(code, lang) {
    var language = String(lang || '').trim();
    var label = language ? escapeHtml(language) : 'code';
    var cls = language ? ' class="language-' + escapeHtml(language) + '"' : '';
    var ref = stashCode(code);
    return (
      '<div class="code-block">' +
      '<div class="code-head"><span class="lang">' + label + '</span>' +
      '<button class="copy-btn" type="button" data-code-ref="' + ref + '">复制</button></div>' +
      '<pre><code' + cls + '>' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  function indentOf(line) {
    var m = String(line || '').match(/^(\s*)/);
    return m ? m[1].replace(/\t/g, '  ').length : 0;
  }

  var UL_RE = /^\s{0,12}[-*+]\s+(.*)$/;
  var OL_RE = /^\s{0,12}\d+[.)]\s+(.*)$/;

  /** 列表（支持一层层嵌套） */
  function parseList(lines, start, store) {
    var baseIndent = indentOf(lines[start]);
    var ordered = OL_RE.test(lines[start]);
    var items = [];
    var i = start;
    var current = null;

    while (i < lines.length) {
      var line = lines[i];

      // 空行：后面若仍是同级/更深列表项则继续，否则结束
      if (!line.trim()) {
        var nxt = lines[i + 1];
        if (nxt && nxt.trim() && indentOf(nxt) >= baseIndent && (UL_RE.test(nxt) || OL_RE.test(nxt))) {
          i++;
          continue;
        }
        break;
      }

      var sub = line.match(UL_RE);
      var subOl = line.match(OL_RE);
      if (!sub && !subOl) {
        // 懒换行续写
        if (current && indentOf(line) > baseIndent) {
          current.lines.push(inline(line.trim(), store));
          i++;
          continue;
        }
        break;
      }

      var ind = indentOf(line);
      if (ind < baseIndent) break;

      if (ind > baseIndent) {
        if (!current) break;
        var nested = parseList(lines, i, store);
        current.children.push(nested.html);
        i = nested.next;
        continue;
      }

      // 同级但类型切换 → 交给外层重新起一个列表
      if (subOl ? !ordered : ordered) break;

      current = {
        lines: [inline((sub ? sub[1] : subOl[1]) || '', store)],
        children: [],
      };
      items.push(current);
      i++;
    }

    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + '>';
    for (var k = 0; k < items.length; k++) {
      html += '<li>' + items[k].lines.join('<br>') + items[k].children.join('') + '</li>';
    }
    html += '</' + tag + '>';

    return { html: html, next: i };
  }

  function render(src) {
    var store = [];
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var out = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map(function (l) { return inline(l, store); }).join('<br>') + '</p>');
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块（未闭合也按代码块渲染，适配流式输出中间态）
      var fence = line.match(/^\s*```+\s*([A-Za-z0-9_+#.\-]*)\s*$/);
      if (fence) {
        flushPara();
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push(codeBlockHtml(buf.join('\n'), fence[1]));
        continue;
      }

      if (!line.trim()) {
        flushPara();
        i++;
        continue;
      }

      // 分割线
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      // 标题
      var h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        flushPara();
        var level = Math.min(h[1].length, 4);
        out.push('<h' + level + '>' + inline(h[2], store) + '</h' + level + '>');
        i++;
        continue;
      }

      // 引用（连续多行合并）
      if (/^\s{0,3}>\s?/.test(line)) {
        flushPara();
        var quotes = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          quotes.push(inline(lines[i].replace(/^\s{0,3}>\s?/, ''), store));
          i++;
        }
        out.push('<blockquote>' + quotes.join('<br>') + '</blockquote>');
        continue;
      }

      // 列表
      if (UL_RE.test(line) || OL_RE.test(line)) {
        flushPara();
        var res = parseList(lines, i, store);
        out.push(res.html);
        i = res.next;
        continue;
      }

      para.push(line);
      i++;
    }

    flushPara();

    // 还原行内代码占位符
    var html = out.join('');
    return html.replace(new RegExp(PH + '(\\d+)' + PH, 'g'), function (_, idx) {
      return store[Number(idx)] || '';
    });
  }

  global.renderMarkdown = render;
  global.mdCodeStore = codeStore;
})(window);
