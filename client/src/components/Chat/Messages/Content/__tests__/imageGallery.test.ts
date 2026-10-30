import { groupImageBlocks, standaloneImages } from '../imageGallery';

const a = 'https://cdn.example.com/one.png';
const b = 'https://cdn.example.com/two.png';
const c = 'https://cdn.example.com/three.png';

describe('chat2api original side-by-side image galleries', () => {
  it('recognizes consecutive three-image markdown with or without paragraph boundaries', () => {
    expect(standaloneImages(`![a](${a}) ![b](${b}) ![c](${c})`)).toHaveLength(3);
    const blocks = [a, b, c].map((src, i) => ({
      key: String(i), raw: `![image ${i}](${src})`, value: i,
    }));
    const output = groupImageBlocks(blocks);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: 'gallery', images: [
      { src: a, alt: 'image 0' }, { src: b, alt: 'image 1' }, { src: c, alt: 'image 2' },
    ] });
  });
  it('preserves prose, code fences, URLs outside the safe policy, and single images', () => {
    const prose = { key: 'intro', raw: 'See ![preview](' + a + ') in this paragraph', value: 0 };
    const image = { key: 'img', raw: '![](https://cdn.example.com/one.png)', value: 1 };
    const code = { key: 'code', raw: '```md\n![x](' + b + ')\n```', value: 2 };
    expect(standaloneImages('![bad](javascript:alert(1))')).toEqual([]);
    expect(standaloneImages('![bad](data:image/png;base64,ABC)')).toEqual([]);
    expect(groupImageBlocks([prose, image, code])).toMatchObject([
      { type: 'block' }, { type: 'block' }, { type: 'block' },
    ]);
  });
  it('does not join galleries across intervening text', () => {
    const rows = [
      { key: 'a', raw: `![a](${a})`, value: 0 },
      { key: 'text', raw: 'caption and details', value: 1 },
      { key: 'b', raw: `![b](${b})`, value: 2 },
      { key: 'c', raw: `![c](${c})`, value: 3 },
    ];
    const groups = groupImageBlocks(rows);
    expect(groups.map((x) => x.type)).toEqual(['block', 'block', 'gallery']);
  });
});
