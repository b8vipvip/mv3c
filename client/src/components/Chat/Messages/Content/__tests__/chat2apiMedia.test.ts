import { chat2apiMediaUrls } from '../chat2apiMedia';

const source = 'http://chat2api.mv3.cn/api/media/med_1234567890123456/longSecureToken123456789';

describe('chat2api generated asset URLs', () => {
  it('uses a small preview but keeps the full original for download', () => {
    expect(chat2apiMediaUrls(source, false)).toEqual({
      preview: source + '/thumbnail',
      original: source,
    });
  });

  it('upgrades both archived media URLs to HTTPS when mv3c is secure', () => {
    const expected = source.replace('http:', 'https:');
    expect(chat2apiMediaUrls(source, true)).toEqual({
      preview: expected + '/thumbnail',
      original: expected,
    });
  });

  it('is idempotent for upstream-provided thumbnail links', () => {
    const original = source.replace('http:', 'https:');
    expect(chat2apiMediaUrls(original + '/thumbnail?ver=1', true)).toEqual({
      preview: original + '/thumbnail?ver=1',
      original: original + '?ver=1',
    });
  });

  it('keeps unrelated links, opaque data images and local URLs unmodified', () => {
    for (const link of [
      'http://example.com/photo.jpg',
      'https://other.example/api/media/ordinary/photo.png',
      '/images/from-local-store.png',
      'data:image/png;base64,YWJj',
      'http://user:pass@host/api/media/med_1234567890123456/token1234567890',
    ]) {
      expect(chat2apiMediaUrls(link, true)).toEqual({ preview: link, original: link });
    }
  });
});
