import { createLiteralSearchRegex, extractNativeSearchUser } from './nativeSearch';

describe('mv3c native chat history search', () => {
  it('searches literal text without evaluating regex metacharacters', () => {
    expect(createLiteralSearchRegex('a.*(B)').test('A.*(b)')).toBe(true);
    expect(createLiteralSearchRegex('a.*(B)').test('abc')).toBe(false);
    expect(createLiteralSearchRegex('中文记录').test('一条中文记录')).toBe(true);
    expect(createLiteralSearchRegex('').test('anything')).toBe(false);
  });
  it('never broadens a missing or injected user filter', () => {
    const id = '507f1f77bcf86cd799439011';
    expect(extractNativeSearchUser('user = "' + id + '"')).toBe(id);
    expect(extractNativeSearchUser('user = "another-user"')).toBeNull();
    expect(extractNativeSearchUser('user = "' + id + '" OR user = "other"')).toBeNull();
    expect(extractNativeSearchUser(undefined)).toBeNull();
  });
});
