import { isInternalMediaHandoff } from './internalMediaHandoff';

describe('historical ChatGPT media tool markers', () => {
  test.each([
    '{"skipped_mainline":true}',
    '{"skipped_mainline":true}{"skipped_mainline":true}',
    ' { "skipped_mainline": true } { "skipped_mainline":true } ',
  ])('identifies internal handoff text %s', (value) => {
    expect(isInternalMediaHandoff(value)).toBe(true);
  });

  test.each([
    '{"skipped_mainline":false}',
    '{"skipped_mainline":true,"reply":"hello"}',
    '{"skipped_mainline":true} actual text',
    'Here is a cat avatar: ![cat](data:image/png;base64,YWJj)',
    '',
  ])('preserves ordinary content %s', (value) => {
    expect(isInternalMediaHandoff(value)).toBe(false);
  });
});
