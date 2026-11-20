import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, rm, symlink, link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {documentTool, existingDocumentPath, readDocumentFile, writeDocumentFile} from '../scripts/pi-documents.mjs';

async function workspace(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-documents-'));
  t.after(() => rm(tmp, {recursive: true, force: true}));
  const root = path.join(tmp, 'agent');
  await mkdir(root);
  return {root, call: args => documentTool({root, ...args})};
}

for (const [format, fields, expect] of [
  ['docx', {text: '标题\n中文正文'}, /标题\n中文正文/],
  [
    'xlsx',
    {
      rows: [
        ['项目', '数量'],
        ['校对', 3],
        ['=1+2', true]
      ]
    },
    /项目\t数量\n校对\t3\n=1\+2\tTrue/
  ],
  [
    'pptx',
    {
      slides: [
        {title: '进度', body: '第一步\n第二步'},
        {title: '验收', body: '交付'}
      ]
    },
    /进度\n第一步\n第二步\n\[幻灯片 2\]\n验收\n交付/
  ]
]) {
  test('writes a real ' + format + ' package and extracts its content', async t => {
    const {root, call} = await workspace(t);
    const file = '输出/样例.' + format;
    let saved;
    try {
      saved = await call({operation: 'write', path: file, ...fields});
    } catch (error) {
      if (error.code === 'MISSING_MODULE') {
        t.skip(error.message);
        return;
      }
      throw error;
    }
    assert.ok(saved.bytes > 2000);
    assert.equal((await readDocumentFile(root, file)).subarray(0, 4).toString(), 'PK\u0003\u0004');
    const read = await call({operation: 'read', path: file});
    assert.equal(read.truncated, false);
    assert.match(read.text, expect);
  });
}

test('UTF-8, CSV, uploads, limits and nested listing share the same workspace', async t => {
  const {root, call} = await workspace(t);
  await call({
    operation: 'write',
    path: 'report.csv',
    rows: [
      ['城市', '数量'],
      ['上海,中国', -3],
      ['=abc', '普通']
    ]
  });
  assert.match((await call({operation: 'read', path: 'report.csv'})).text, /"上海,中国",-3\r\n'=abc,普通/);
  await call({operation: 'write', path: '演示/index.html', text: '<h1>测试</h1>'});
  const nested = await call({operation: 'list', path: '演示'});
  assert.deepEqual(nested.files, [{kind: 'file', name: 'index.html', bytes: 15}]);
  assert.ok((await call({operation: 'list'})).files.some(f => f.name === '演示' && f.kind === 'directory'));
  const first = Buffer.from([0, 255, 254, 1]);
  await writeDocumentFile(root, '演示/截图.png', first);
  assert.deepEqual(await readDocumentFile(root, '演示/截图.png'), first);
  await assert.rejects(readDocumentFile(root, '演示/截图.png', {maxBytes: 3}), e => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(writeDocumentFile(root, '演示/截图.png', Buffer.alloc(0)), e => e.code === 'FILE_EXISTS');
  await writeDocumentFile(root, '演示/截图.png', Buffer.from('ok'), {overwrite: true});
  assert.equal((await readDocumentFile(root, '演示/截图.png')).toString(), 'ok');
  assert.match(await existingDocumentPath(root, '演示/截图.png'), /\/演示\/截图\.png$/u);
  await writeDocumentFile(root, 'long.txt', Buffer.from('长'.repeat(33000)));
  const read = await call({operation: 'read', path: 'long.txt'});
  assert.equal(read.truncated, true);
  assert.equal(read.text.length, 32000);
  await assert.rejects(call({operation: 'write', path: 'long.txt', text: '再写'}), e => e.code === 'FILE_EXISTS');
});

test('blocks paths outside the seat, file/parent symlinks and shared inodes for all access modes', async t => {
  const {root, call} = await workspace(t);
  await writeDocumentFile(root, 'ordinary.txt', Buffer.from('isolated'));
  await link(path.join(root, 'ordinary.txt'), path.join(root, 'alias.txt'));
  await symlink(path.dirname(root), path.join(root, 'other'));
  await symlink(path.join(root, 'alias.txt'), path.join(root, 'shortcut'));
  for (const file of [
    '../elsewhere',
    path.join(root, 'alias.txt'),
    '.hidden',
    'other/secret',
    'alias.txt',
    'shortcut'
  ]) {
    await assert.rejects(readDocumentFile(root, file));
    await assert.rejects(writeDocumentFile(root, file, Buffer.from('replacement'), {overwrite: true}));
    await assert.rejects(existingDocumentPath(root, file));
  }
  assert.deepEqual((await call({operation: 'list'})).files, []);
});

test('concurrent creates keep one complete file', async t => {
  const {root} = await workspace(t);
  const outcomes = await Promise.allSettled(
    ['first', 'second'].map(v => writeDocumentFile(root, 'report.txt', Buffer.from(v)))
  );
  assert.equal(outcomes.filter(s => s.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(s => s.status === 'rejected').reason.code, 'FILE_EXISTS');
  assert.ok(['first', 'second'].includes((await readDocumentFile(root, 'report.txt')).toString()));
});

test('extracts the text layer of a simple local PDF', async t => {
  const {root, call} = await workspace(t);
  const stream = 'BT /F1 12 Tf 10 20 Td (local document) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let raw = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(raw.length);
    raw += i + 1 + ' 0 obj\n' + obj + '\nendobj\n';
  }
  const xref = raw.length;
  raw +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map(v => String(v).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n' +
    xref +
    '\n%%EOF\n';
  await writeDocumentFile(root, 'sample.pdf', Buffer.from(raw));
  try {
    assert.match((await call({operation: 'read', path: 'sample.pdf'})).text, /local document/);
  } catch (e) {
    if (e.code === 'MISSING_MODULE') {
      t.skip(e.message);
      return;
    }
    throw e;
  }
});

test('exports a searchable Chinese PDF with explicit and automatic page breaks', async t => {
  const {root, call} = await workspace(t);
  const lines = Array.from({length: 90}, (_, i) => '第' + String(i + 1).padStart(2, '0') + '行：本地中文测试。');
  const file = '中文分页.pdf';
  const first = '首页：甲 & 乙 <验收>';
  const text = first + '\f正文共九十行。\n' + lines.join('\n');
  try {
    await call({operation: 'write', path: file, text});
    const recovered = await call({operation: 'read', path: file});
    assert.ok(recovered.text.includes(first));
    assert.ok(recovered.text.includes(lines.at(-1)));
  } catch (error) {
    if (error.code === 'MISSING_MODULE') {
      t.skip(error.message);
      return;
    }
    throw error;
  }
  const raw = await readDocumentFile(root, file);
  assert.match(raw.toString('ascii', 0, 8), /^%PDF-1\./);
  const pageObjects = raw.toString('latin1').match(/\/Type\s*\/Page\b/g) || [];
  assert.ok(pageObjects.length >= 4);
  // Poppler is a third parser on machines where available, independent of both
  // ReportLab's writer and the pypdf text extraction used in the tool.
  let parsed;
  try {
    ({stdout: parsed} = await promisify(execFile)('pdftotext', [
      '-layout',
      '-enc',
      'UTF-8',
      path.join(root, file),
      '-'
    ]));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const pages = parsed.trimEnd().split('\f');
  assert.equal(pages.length, pageObjects.length);
  assert.equal(pages[0].trim(), first);
  assert.ok(pages[1].includes('正文共九十行。'));
  assert.ok(pages.at(-1).includes(lines.at(-1)));
  for (const line of lines) assert.ok(parsed.includes(line));
});

test('uploaded workbook ranges and grouped slide content are read from the actual OOXML', async t => {
  const {root, call} = await workspace(t);
  const sheets = [
    [
      'xlsx',
      {
        rows: [
          ['城市', '数量'],
          ['苏州', 9]
        ]
      }
    ],
    ['pptx', {slides: [{title: '阶段小结', body: '已完成校对'}]}]
  ];
  try {
    for (const [ext, fields] of sheets) await call({operation: 'write', path: '输入.' + ext, ...fields});
  } catch (error) {
    if (error.code === 'MISSING_MODULE') return t.skip(error.message);
    throw error;
  }
  // Simulate two common Office authoring patterns using only the Python standard
  // library. Leave the actual worksheet cells and slide text intact.
  const prepare = `
import os, sys, zipfile, xml.etree.ElementTree as ET
root = sys.argv[1]
def revise(ext, item, edit):
    src = os.path.join(root, '输入.' + ext)
    with zipfile.ZipFile(src) as original, zipfile.ZipFile(os.path.join(root, '上传.' + ext), 'w') as result:
        for key in original.namelist():
            data = original.read(key)
            if key == item:
                xml = ET.fromstring(data)
                edit(xml)
                data = ET.tostring(xml)
            result.writestr(key, data)
def stale_dimension(sheet):
    sheet.find('{*}dimension').set('ref', 'A1')
def group_slide(slide):
    tree = slide.find('.//{*}spTree')
    shape = tree.findall('{*}sp')[-1]
    tree.remove(shape)
    ns = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
    def group(parent, identifier):
        element = ET.SubElement(parent, ns+'grpSp')
        props = ET.SubElement(element, ns+'nvGrpSpPr')
        ET.SubElement(props, ns+'cNvPr', id=identifier, name='Group '+identifier)
        ET.SubElement(props, ns+'cNvGrpSpPr')
        ET.SubElement(props, ns+'nvPr')
        ET.SubElement(element, ns+'grpSpPr')
        return element
    group(group(tree, '8'), '9').append(shape)
revise('xlsx', 'xl/worksheets/sheet1.xml', stale_dimension)
revise('pptx', 'ppt/slides/slide1.xml', group_slide)
`;
  const python = process.env.OFFICE_DOCUMENT_PYTHON || 'python3';
  try {
    await promisify(execFile)(python, ['-I', '-c', prepare, root]);
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.OFFICE_DOCUMENT_PYTHON) throw error;
    await promisify(execFile)(
      path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
      ['-I', '-c', prepare, root]
    );
  }
  const results = await Promise.all(sheets.map(([ext]) => call({operation: 'read', path: '上传.' + ext})));
  assert.deepEqual(
    results.map(r => r.text),
    ['[Sheet]\n城市\t数量\n苏州\t9', '[幻灯片 1]\n阶段小结\n已完成校对']
  );
  assert.ok(results.every(r => !r.truncated));
});
