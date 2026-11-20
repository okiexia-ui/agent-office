import {validateVisualContent} from '../worker/workspace.js';

const formats = {
  document: 'content 是最终文档正文字符串，可使用基本 Markdown。',
  chart:
    'content 是对象 {"labels":["名称"],"values":[数值],"unit":"单位"}。使用 1 至 40 个标签和等长的有限数值。只用请求或任务材料中提供的数据。',
  table:
    'content 是对象 {"columns":["列名"],"rows":[["单元格"]]}。最多 12 列、100 行，每行和列数一致，单元格只放字符串、数值、真假或 null。',
  html: 'content 是包含标记的完整自包含 HTML 字符串。交互用内联 JS、CSS，预览会阻止联网和表单提交。'
};

export function requestedVisual(...fields) {
  // The destination is shared. An ordinary request to write or discuss a
  // document in private chat must never implicitly publish its contents.
  const commandPattern = /^\s*(?:@\S+\s+)*\/visual\s+(document|chart|table|html)\b/i;
  const command = fields.map(field => commandPattern.exec(field)).find(Boolean);
  // Treat quoted examples and questions about the feature as conversation.
  const unquoted = fields.map(text =>
    text
      .replace(/((?:```)[\s\S]*?(?:```)|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|《[^》]*》)/g, '')
      .replace(/^\s*(?:@\S+\s+)*/, '')
  );
  // A later line can withdraw permission given in the opening request.
  if (
    /(?:不要|不必|不需|不得|别|请勿|暂不|先不|取消|停止|禁止)(?:\s*(?:向外|对外|公开)?发|[^，。！？;；\n]{0,120}(?:发布|共享|分享|公开))|等我确认|仅供私聊|只(?:在私聊|给我看)|(?:do not|don't)\s+(?:share|publish)/i.test(
      unquoted.join('\n')
    )
  )
    return null;
  if (command) return command[1].toLowerCase();
  for (const field of unquoted) {
    const kind = publicationKind(field.split(/[:：\n]/, 1)[0]);
    if (kind) return kind;
  }
  return null;
}

function publicationKind(instruction) {
  if (
    !/^(?:(?:请|麻烦)(?:你|帮我)?|帮我)?(?:把|将|做|为|生成|整理|制作|梳理|创建|绘制|写|发布)|^(?:please\s+)?publish\b/i.test(
      instruction
    ) ||
    /[?？]|吗[。！!]?\s*$|(?:不要|不必|不需|不得|别|请勿|禁止|取消|暂缓|暂不|先不|等我|确认后)/.test(instruction)
  )
    return null;
  const destination =
    /发布(?:至|到|在)\s*(?:办公室)?(?:共享)?(?:成果(?:区|面板)?|visual\b)|发布(?:成|为)\s*(?:图表|文档|表格|html)|publish.{0,80}\b(?:visual pane|results pane)\b/i;
  if (
    !destination.test(instruction) ||
    /(?:不要|不必|不需|不得|别|请勿|禁止|取消|如何|怎么|能否|是否|已经|已)[^，。！？;；\n]{0,120}发布|(?:do not|don't|how to)\s+publish|发布(?:到|至)\s*(?:成果区|visual)的/i.test(
      instruction
    )
  )
    return null;
  if (/HTML|交互网页/i.test(instruction)) return 'html';
  if (/图表|柱状图|条形图|折线图|\bchart\b/i.test(instruction)) return 'chart';
  if (/表格|数据表|\btable\b/i.test(instruction)) return 'table';
  if (/文档|报告|说明书|\bdocument\b/i.test(instruction)) return 'document';
  return null;
}

export function visualPrompt(kind, request, tasks) {
  return [
    '为用户明确请求发布到办公室共享成果区的作品生成内容。本次仅使用下方材料。直接输出一个 JSON 对象，不要添加解释。',
    '如果材料不足以完成请求，输出 {"need":"请用户补充的具体信息"}。禁止虚构事实或数字。',
    '否则输出 {"title":"作品标题","content":实际内容} 。标题最多 100 字符。正文最多 32000 字符。' + formats[kind],
    JSON.stringify({
      request,
      ...(tasks && {assignedTasks: tasks.map(({title, status, progress}) => ({title, status, progress}))})
    })
  ].join('\n');
}

export function visualOutcome(kind, text) {
  const invalid = {status: 'paused', result: '模型返回的成果格式无效。请重试，或缩小要交付的内容范围。'};
  try {
    const raw = text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    const data = JSON.parse(raw);
    if (typeof data?.need === 'string' && data.need.trim())
      return {status: 'paused', result: '需要补充材料：' + data.need.trim().slice(0, 1500)};
    if (typeof data?.title !== 'string' || !data.title.trim() || data.title.length > 100) return invalid;
    const structured = kind === 'chart' || kind === 'table';
    const content = structured && typeof data.content !== 'string' ? JSON.stringify(data.content) : data.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 32000) return invalid;
    if (kind === 'html' && !/<[a-z][\w:-]*(?:\s[^>]*|\/?)>/i.test(content)) return invalid;
    validateVisualContent(kind, content);
    // IDs and link targets belong to the runner, never to the model.
    return {visual: {kind, title: data.title.trim(), content: content.trim()}};
  } catch {
    return invalid;
  }
}
