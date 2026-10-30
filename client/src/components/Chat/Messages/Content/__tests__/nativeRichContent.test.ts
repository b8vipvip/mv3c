import { isOwnedAsset, validateNativeContent, shouldApplyNativeSnapshot, hasUnrepresentedNativeLinks } from '../nativeRichContent';

const asset='https://chat2api.example.com/api/media/med_123456789/secretABC12345678';
const input = {
 version: 1,revision: 2,assets: [asset],
 root: {tag:'div',style:{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px'},
  children:[{tag:'p',text:'hello'},{tag:'img',media_index:0}]},
};
describe('safe native ChatGPT rich renderer contract',()=>{
 it('supports only owned media and safe grid elements',()=>{
  expect(validateNativeContent(input)).toEqual(input);
  expect(isOwnedAsset('https://evil.com/image.png')).toBe(false);
 });
 it('falls back for scripts and CSS injection',()=>{
  for(const root of [
   {tag:'iframe',children:[]},
   {tag:'div',style:{backgroundImage:'url(https://example.com/secret)'}},
   {tag:'div',style:{position:'fixed'}},
   {tag:'img',media_index:1},
  ]) expect(validateNativeContent({...input,root})).toBeNull();
 });
 it('fails closed on missing, unordered or opaque media URLs',()=>{
  expect(validateNativeContent({...input,assets:[]})).toBeNull();
  expect(validateNativeContent({...input,assets:['blob:secret']})).toBeNull();
  expect(validateNativeContent({...input,assets:['https://evil.com/abc.png']})).toBeNull();
  expect(validateNativeContent({...input,assets:[asset,asset]})).toBeNull();
 });
});

describe('native snapshot readiness after latest DOM revision', () => {
  it('updates assets without asking the Worker for a new DOM version', () => {
    const prev = validateNativeContent(input);
    expect(prev).not.toBeNull();
    const next = { ...(prev as NonNullable<typeof prev>), assets: [
      'https://chat2api.example.com/api/media/med_987654321/readyTOKEN12345678',
    ] };
    expect(shouldApplyNativeSnapshot(prev, next)).toBe(true);
    expect(shouldApplyNativeSnapshot(next, next)).toBe(false);
    expect(shouldApplyNativeSnapshot(next, { ...next, revision: 1 })).toBe(false);
    expect(shouldApplyNativeSnapshot(null, next)).toBe(true);
  });
});

describe('native-rich v1 link and file handoff preservation', () => {
  it('retains verified generated file download actions from Markdown', () => {
    const files = '[📎 report.xlsx](https://files.example.com/api/generated-files/file_12345678/tokenABC12345)';
    expect(hasUnrepresentedNativeLinks(files)).toBe(true);
    expect(hasUnrepresentedNativeLinks('Some [source](https://example.com/report)')).toBe(true);
    expect(hasUnrepresentedNativeLinks('<https://example.com/reference>')).toBe(true);
    expect(hasUnrepresentedNativeLinks('Download: https://example.com/report.zip')).toBe(true);
    expect(hasUnrepresentedNativeLinks('Site www.example.com')).toBe(true);
  });

  it('still enables native image-only layout and unlinked rich text', () => {
    expect(hasUnrepresentedNativeLinks('![image](https://files.example.com/api/media/med_1234567/tokenABC12345)')).toBe(false);
    expect(hasUnrepresentedNativeLinks('# Heading\\n\\n| A | B |\\n| - | - |')).toBe(false);
    expect(hasUnrepresentedNativeLinks('')).toBe(false);
  });

  it('does not allow a malicious or incomplete link to bypass conservative fallback', () => {
    expect(hasUnrepresentedNativeLinks('[📎 report.zip](/api/generated-files/file_12345678/token)')).toBe(true);
    expect(hasUnrepresentedNativeLinks('[docs](sandbox:/mnt/data/notes.pdf)')).toBe(true);
  });
});
