import { generatedFileHref } from '../generatedFile';

const source = 'http://chat2api.mv3.cn/api/generated-files/gen_abcdefghijklmnop/tokenAbCdEf1234567890';

describe('chat2api generated-file link', () => {
  it('recognizes bounded bearer URLs from the archive', () => {
    expect(generatedFileHref(source, false)).toBe(source);
  });

  it('upgrades a generated file URL to HTTPS on a secure page', () => {
    expect(generatedFileHref(source, true)).toBe(source.replace('http:', 'https:'));
  });

  it('leaves ordinary links and invalid schemes to the normal markdown renderer', () => {
    expect(generatedFileHref('https://example.com/readme.pdf', true)).toBeNull();
    expect(generatedFileHref('javascript:alert(1)', true)).toBeNull();
    expect(generatedFileHref('data:text/html,hello', true)).toBeNull();
    expect(generatedFileHref('/mnt/data/report.pdf', true)).toBeNull();
    expect(generatedFileHref('https://user:pass@host/api/generated-files/gen_abcdefghijklmnop/token12345678900', true)).toBeNull();
  });
});
