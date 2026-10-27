import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPendingInlineRasterImage as mask } from '../../client/src/components/Chat/Messages/Content/pendingInlineRaster.js';

const image = (label, payload) => `![${label}](data:image/png;base64,${payload})`;
const receiving = '\n\n*图片正在接收…*';

test('multi-image stream retains two complete illustrations but never prints the unfinished third image', () => {
  const first = image('图一', 'YWJj');
  const second = image('图二', 'ZGVm');
  const prefix = ['绘本故事', first, '第二幅插画', second, '第三幅插画'].join('\n\n');
  const third = '![图三](data:image/png;base64,Z2h';
  assert.equal(mask(prefix + '\n\n' + third),
    prefix + receiving);
  assert.equal(mask(prefix + '\n\n' + image('图三', 'Z2hp')),
    prefix + '\n\n' + image('图三', 'Z2hp'));
});

test('first image arriving token by token does not leak its base64 as text', () => {
  assert.equal(mask('前文\n\n![封面](data:image/webp;base64,AAA'),
    '前文' + receiving);
});

test('each additional completed image becomes visible without losing earlier Markdown', () => {
  const a = image('A', 'QUJD');
  const b = image('B', 'REVG');
  const c = image('C', 'R0hJ');
  assert.equal(mask([a,b,c].join('\n\n')), [a,b,c].join('\n\n'));
  assert.equal(mask(a + '\n\n' + b + '\n\n![C](data:image/png;base64,R0'),
    a + '\n\n' + b + receiving);
});

test('short archived chat2api image URLs and file delivery links are never rewritten', () => {
  const response = [
    '![图一](https://chat2api.mv3.cn/api/media/med_123456789012345/longToken123456789)',
    '![图二](https://chat2api.mv3.cn/api/media/med_234567890123456/longToken234567890)',
    '[XLSX](https://chat2api.mv3.cn/api/generated-files/gen_abcdefghijklmnop/tokenAbCdEf1234567890)',
    '[JSON](https://chat2api.mv3.cn/api/generated-files/gen_bcdefghijklmnopq/tokenAbCdEf1234567891)',
  ].join('\n\n');
  assert.equal(mask(response), response);
});

test('non-raster data, ordinary text and code fences remain untouched', () => {
  for (const s of [
    '普通文本，没有图片',
    '![SVG](data:image/svg+xml;base64,PHN2Zz4=',
    'https://example.com/some-image.png',
    '数据分析\n\n```python\nprint("hello")\n```',
  ]) {
    assert.equal(mask(s), s);
  }
});

test('late streaming fragments never force processing of huge partial image payload', () => {
  const prefix = image('A', 'YWJj') + '\n\n第二幅';
  const stream = prefix + '\n\n![B](data:image/jpeg;base64,' + 'A'.repeat(1024 * 256);
  assert.equal(mask(stream), prefix + receiving);
});

test('closing a later image unblocks both earlier and later finished content', () => {
  const first = image('第一张', 'YWJj');
  const later = '![SECOND](data:image/GIF;base64,YWJj)';
  const trailing = '\n\n这是结尾文字';
  assert.equal(mask(first + '\n\n' + later + trailing), first + '\n\n' + later + trailing);
});
