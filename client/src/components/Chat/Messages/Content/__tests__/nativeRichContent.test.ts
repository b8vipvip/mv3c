import { isOwnedAsset, isOwnedGeneratedFile, validateNativeContent, shouldApplyNativeSnapshot, hasUnrepresentedNativeLinks, hasNativeTextCoverage } from '../nativeRichContent';

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

describe('canonical Markdown completeness guard for native-rich v1', () => {
  it('rejects a schema-valid partial native snapshot with missing long-answer tail', () => {
    const full = 'Chapter One: ' + 'full long content. '.repeat(450);
    const partial = {
      version: 1, revision: 4, assets: [],
      root: { tag: 'div', children: [{ tag: 'p', text: 'Chapter One: full long content.' }] },
    };
    expect(validateNativeContent(partial)).not.toBeNull();
    expect(hasNativeTextCoverage(partial, full)).toBe(false);
  });

  it('accepts a sufficiently complete rich reply and short answers', () => {
    const answer = 'The detailed explanation. '.repeat(130);
    const native = { version: 1, revision: 8, assets: [],
      root: { tag: 'div', children: [{ tag: 'p', text: answer }] } };
    expect(hasNativeTextCoverage(native, answer)).toBe(true);
    expect(hasNativeTextCoverage(native, 'short reply')).toBe(true);
  });

  it('continues to prefer the canonical answer when older Workers omit half the text', () => {
    const complete = 'Long answer paragraph. '.repeat(180);
    const incomplete = { version: 1, revision: 9, assets: [],
      root: { tag: 'p', text: 'Long answer paragraph. '.repeat(70) } };
    expect(hasNativeTextCoverage(incomplete, complete)).toBe(false);
    expect(hasNativeTextCoverage({}, complete)).toBe(false);
  });
});

describe('safe fractional native CSS grid layout', () => {
  it('retains fractional computed widths in a native picture gallery', () => {
    const rich = { ...input,
      root: { ...input.root, style: { display: 'grid',
        gridTemplateColumns: '348.5px 348.25px 1024px', gap: '8px' } } };
    expect(validateNativeContent(rich)).toEqual(rich);
  });
  it('continues rejecting unsafe CSS and excessive pixel widths', () => {
    for (const value of ['348.5px;position:fixed',
      'url(https://evil.example/x)', '100000px 100px',
      'repeat(3, auto)']) {
      const rich = { ...input, root: { ...input.root,
        style: { display: 'grid', gridTemplateColumns: value } } };
      expect(validateNativeContent(rich)).toBeNull();
    }
  });
});

describe('verified native file cards preserve canonical download targets', () => {
  const pending = 'https://files.example.com/api/generated-files/pending/pgen_' +
    'a'.repeat(32) + '/' + 'B'.repeat(24);
  const file = { filename: 'plan.xlsx', url: pending, bytes: 2048, status: 'processing' as const };
  const rich = { ...input, files: [file] };
  const canonical = 'Project plan: [📎 plan.xlsx](' + pending + ')';
  it('permits one exact owned file card without sacrificing native image layout', () => {
    expect(isOwnedGeneratedFile(pending)).toBe(true);
    expect(validateNativeContent(rich)).toEqual(rich);
    expect(hasUnrepresentedNativeLinks(canonical, rich)).toBe(false);
    expect(hasUnrepresentedNativeLinks(canonical, input)).toBe(true);
  });
  it('does not discard any ordinary external links or unrelated file references', () => {
    expect(hasUnrepresentedNativeLinks(canonical + ' [docs](https://example.com)', rich)).toBe(true);
    expect(hasUnrepresentedNativeLinks(canonical.replace('plan.xlsx', 'unmatched.xlsx'), rich)).toBe(true);
    expect(hasUnrepresentedNativeLinks(canonical + ' ' + pending, rich)).toBe(true);
  });
  it('refuses untrusted, duplicated and malformed file descriptors', () => {
    expect(isOwnedGeneratedFile('https://evil.example/file.zip')).toBe(false);
    expect(isOwnedGeneratedFile('javascript:alert(1)')).toBe(false);
    expect(validateNativeContent({ ...input, files: [{ ...file, url: 'blob:secret' }] })).toBeNull();
    expect(validateNativeContent({ ...input, files: [file, file] })).toBeNull();
    expect(validateNativeContent({ ...input, files: [{ ...file, status: 'unverified' }] })).toBeNull();
    expect(validateNativeContent({ ...input, files: [{ ...file, onClick: 'alert(1)' }] })).toBeNull();
    expect(validateNativeContent({ ...input, files: [{ ...file, bytes: 25000000 }] })).toBeNull();
  });
  it('replaces a same-revision snapshot when a file becomes available', () => {
    const early = validateNativeContent({ ...input, files: [] });
    const ready = validateNativeContent(rich);
    expect(early).not.toBeNull();
    expect(ready).not.toBeNull();
    expect(shouldApplyNativeSnapshot(early, ready as NonNullable<typeof ready>)).toBe(true);
    expect(shouldApplyNativeSnapshot(ready, ready as NonNullable<typeof ready>)).toBe(false);
  });
});

describe('post-terminal verified file archive state', () => {
  const url = 'https://files.example.com/api/generated-files/pending/pgen_' +
    'b'.repeat(32) + '/' + 'C'.repeat(24);
  const file = { filename: 'report.zip', url, bytes: 4096 };
  it('accepts strict processing, ready and failed states, and rejects arbitrary status', () => {
    for (const status of ['processing', 'ready', 'failed']) {
      const value = validateNativeContent({ ...input, files: [{ ...file, status }] });
      expect(value?.files?.[0].status).toBe(status);
    }
    expect(validateNativeContent({ ...input,
      files: [{ ...file, status: 'uploaded' }] })).toBeNull();
  });
  it('replaces a same-revision snapshot as the durable archive settles', () => {
    const processing = validateNativeContent({ ...input,
      files: [{ ...file, status: 'processing' }] });
    const ready = validateNativeContent({ ...input,
      files: [{ ...file, status: 'ready' }] });
    const failed = validateNativeContent({ ...input,
      files: [{ ...file, status: 'failed' }] });
    expect(shouldApplyNativeSnapshot(processing, ready!)).toBe(true);
    expect(shouldApplyNativeSnapshot(processing, failed!)).toBe(true);
    expect(shouldApplyNativeSnapshot(ready, ready!)).toBe(false);
  });
  it('never requires trusting an unrepresented external file link', () => {
    const doc = { ...input, files: [{ ...file, status: 'ready' }] };
    const canonical = '[📎 report.zip](' + url + ')';
    expect(hasUnrepresentedNativeLinks(canonical, doc)).toBe(false);
    expect(hasUnrepresentedNativeLinks(canonical + ' https://other.example.com/unsafe', doc)).toBe(true);
  });
});
