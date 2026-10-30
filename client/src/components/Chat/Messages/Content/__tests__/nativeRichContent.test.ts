import { isOwnedAsset, validateNativeContent } from '../nativeRichContent';

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
