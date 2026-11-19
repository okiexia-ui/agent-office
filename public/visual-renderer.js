export const escapeHTML = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]
  );
export const VISUAL_KINDS = {document: '文档', chart: '图表', table: '表格', html: '交互作品'};
export function markdown(text) {
  const lines = String(text).split('\n'),
    out = [];
  let code = false,
    list = false;
  const inline = value =>
    escapeHTML(value)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (list) {
        out.push('</ul>');
        list = false;
      }
      out.push(code ? '</code></pre>' : '<pre><code>');
      code = !code;
      continue;
    }
    if (code) {
      out.push(escapeHTML(line) + '\n');
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (!list) {
        out.push('<ul>');
        list = true;
      }
      out.push('<li>' + inline(line.slice(2)) + '</li>');
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    const heading = line.match(/^(#{1,3}) (.+)/);
    out.push(
      heading
        ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`
        : line
          ? `<p>${inline(line)}</p>`
          : ''
    );
  }
  if (code) out.push('</code></pre>');
  if (list) out.push('</ul>');
  return out.join('');
}
function table(columns, rows) {
  return `<table class="data-table"><thead><tr>${columns.map(c => `<th scope="col">${escapeHTML(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${escapeHTML(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function visualBody(visual) {
  if (visual.kind === 'document') return `<div class="document-content">${markdown(visual.content)}</div>`;
  if (visual.kind === 'html') return '';
  const data = JSON.parse(visual.content);
  if (visual.kind === 'table') return table(data.columns, data.rows);
  // Normalize first so even very large finite values cannot overflow the axis.
  const scale = Math.max(...data.values.map(Math.abs), 1),
    values = data.values.map(v => v / scale);
  const lo = Math.min(0, ...values),
    hi = Math.max(0, ...values),
    range = hi - lo || 1,
    zero = (-lo / range) * 100;
  return (
    `<p class="chart-unit">${data.unit ? '单位：' + escapeHTML(data.unit) : '数值对比'}</p>` +
    data.labels
      .map((label, i) => {
        const x = values[i],
          start = ((Math.min(0, x) - lo) / range) * 100,
          width = (Math.abs(x) / range) * 100;
        return `<div class="chart-row"><div class="chart-label"><span>${escapeHTML(label)}</span><strong>${escapeHTML(data.values[i].toLocaleString('zh-CN'))}${escapeHTML(data.unit || '')}</strong></div><div class="chart-track" aria-hidden="true"><span class="chart-zero" style="left:${zero}%"></span><span class="chart-bar" style="left:${start}%;width:${width}%"></span></div></div>`;
      })
      .join('') +
    `<details><summary>查看原始数据</summary>${table(
      ['项目', data.unit || '数值'],
      data.labels.map((label, i) => [label, data.values[i]])
    )}</details>`
  );
}
export function isolatedDocument(content) {
  // Never add allow-same-origin to the hosting iframe. This policy precedes all generated markup.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:20px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#24382b}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}</style></head><body>${content}</body></html>`;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Keep numerical values (including negatives) numeric. Mark formula-like
  // user/model text as literal before quoting it for spreadsheet import.
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@＝＋＠－-]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function visualDownload(visual) {
  const rawTitle = (visual.title || '成果').replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_');
  let title =
    [...rawTitle]
      .slice(0, 64)
      .join('')
      .trim()
      .replace(/[. ]+$/, '') || '成果';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = '_' + title;
  if (visual.kind === 'document')
    return {name: title + '.md', type: 'text/markdown;charset=utf-8', text: visual.content, label: '下载 Markdown'};
  if (visual.kind === 'html') {
    const titleTag = escapeHTML(visual.title || '交互作品');
    const source = escapeHTML(isolatedDocument(visual.content));
    // The sandbox and inner policy follow the artifact when opened from disk.
    // srcdoc inherits the wrapper policy; allow inline code and data assets in the inner document.
    const text = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src about:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titleTag}</title><style>html,body,iframe{display:block;width:100%;height:100%;margin:0;border:0}</style></head><body><iframe title="${titleTag}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${source}"></iframe></body></html>`;
    return {name: title + '.html', type: 'text/html;charset=utf-8', text, label: '下载交互 HTML'};
  }
  const data = JSON.parse(visual.content);
  const chart = visual.kind === 'chart';
  const rows = chart
    ? [
        ['项目', data.unit ? '数值（' + data.unit + '）' : '数值'],
        ...data.labels.map((label, i) => [label, data.values[i]])
      ]
    : [data.columns, ...data.rows];
  return {
    name: title + '.csv',
    type: 'text/csv;charset=utf-8',
    text: '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
    label: chart ? '下载图表数据 CSV' : '下载表格 CSV'
  };
}
