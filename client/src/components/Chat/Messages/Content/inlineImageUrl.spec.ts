import { isSafeRasterImageDataUrl } from './inlineImageUrl';

describe('safe raster data image Markdown rendering', () => {
  test.each(['png', 'jpeg', 'webp', 'gif'])('permits bounded %s images', (type) => {
    expect(isSafeRasterImageDataUrl(`data:image/${type};base64,aGVsbG8=`)).toBe(true);
  });

  test.each([
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)',
    'data:image/png;base64,ab!c',
    'data:image/png;base64,aaaa=',
    'data:image/png;base64,',
    'https://example.com/image.png',
  ])('rejects unsupported or malformed data URL %s', (url) => {
    expect(isSafeRasterImageDataUrl(url)).toBe(false);
  });

  test('rejects payloads larger than the Worker image limit', () => {
    const tooLarge = 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil((4 * 1024 * 1024) / 3) + 4);
    expect(isSafeRasterImageDataUrl(tooLarge)).toBe(false);
  });
});
