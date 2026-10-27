import { sourceFaviconDomain } from '../inlineReferenceIcon';

describe('ChatGPT inline citation favicon recognition', () => {
  it('recognizes official provider URLs with nested https domain', () => {
    expect(sourceFaviconDomain('https://www.google.com/s2/favicons?domain=https://github.com&sz=32'))
      .toBe('github.com');
  });
  it('does not mistake normal diagrams or untrusted sources for citation icons', () => {
    expect(sourceFaviconDomain('https://cdn.example.com/picture.png')).toBeNull();
    expect(sourceFaviconDomain('http://www.google.com/s2/favicons?domain=github.com')).toBeNull();
    expect(sourceFaviconDomain('https://www.google.com/s2/favicons?domain=invalid-domain')).toBeNull();
  });
});
