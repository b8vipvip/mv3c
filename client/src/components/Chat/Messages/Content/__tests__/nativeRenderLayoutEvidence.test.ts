import { countNativeRenderLayout } from '../nativeRenderLayoutEvidence';

describe('redacted native browser layout evidence', () => {
  it('counts actual grid/flex structure and image rows without serializing content', () => {
    const root=document.createElement('div');
    root.innerHTML='<section><div>private message</div><img/><img/></section><div><img/></div>';
    const grid=root.querySelector('section') as HTMLElement;
    grid.style.display='grid';
    const flex=root.querySelector('section div') as HTMLElement;
    flex.style.display='flex';
    root.querySelectorAll('img').forEach((img,index)=>{
      img.getBoundingClientRect = () => ({top:index===2?90:10,left:0,width:60,height:50,
        right:60,bottom:index===2?140:60,x:0,y:index===2?90:10,toJSON:()=>({})});
    });
    const result=countNativeRenderLayout(root);
    expect(result).toEqual({
      renderedGridContainers:1,renderedFlexContainers:1,renderedImageRows:2,
    });
    expect(JSON.stringify(result)).not.toContain('private message');
    expect(JSON.stringify(result)).not.toContain('src');
  });
  it('does not mistake a plain sequential list for a card grid',()=>{
    const root=document.createElement('div');
    root.innerHTML='<p>first game</p><p>second game</p>';
    expect(countNativeRenderLayout(root)).toEqual({
      renderedGridContainers:0,renderedFlexContainers:0,renderedImageRows:0,
    });
  });
});
