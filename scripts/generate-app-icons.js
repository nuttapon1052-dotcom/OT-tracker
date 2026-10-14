/* Rebuild the OT Fast clock marks with node scripts/generate-app-icons.js. */
function appIconPNG(size) {
 const palette=[[41,42,46],[255,159,84],[112,81,59],[184,123,72]];
 const stride=Math.ceil(size/4),raw=new Uint8Array((stride+1)*size);
 function segmentDistance(x,y,ax,ay,bx,by) {
  const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(x-ax-t*dx,y-ay-t*dy);
 }
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const xx=(x+.5)*64/size,yy=(y+.5)*64/size;
  const edge=Math.min(Math.abs(Math.hypot(xx-32,yy-32)-17)-1.75,
   segmentDistance(xx,yy,32,20,32,32)-1.75,segmentDistance(xx,yy,32,32,41,37)-1.75);
  const coverage=Math.max(0,Math.min(1,.5-edge*size/64));
  const color=coverage<.17?0:coverage<.5?2:coverage<.83?3:1;
  raw[y*(stride+1)+1+(x>>2)]|=color<<(6-(x%4)*2);
 }
 function u32(n){return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255];}
 function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
 function chunk(type,bytes){const name=Array.from(type,c=>c.charCodeAt(0)),data=[...name,...bytes];return [...u32(bytes.length),...data,...u32(crc(data))];}
 const deflate=[0x78,0x01];for(let at=0;at<raw.length;at+=65535){
  const block=raw.slice(at,Math.min(at+65535,raw.length)),n=block.length,inv=(~n)&65535;
  deflate.push(at+n===raw.length?1:0,n&255,n>>8,inv&255,inv>>8);
  for(const b of block)deflate.push(b);
 }
 let s1=1,s2=0;for(const b of raw){s1=(s1+b)%65521;s2=(s2+s1)%65521;}
 deflate.push(...u32(((s2<<16)|s1)>>>0));
 return new Uint8Array([137,80,78,71,13,10,26,10,...chunk("IHDR",[...u32(size),...u32(size),2,3,0,0,0]),...chunk("PLTE",palette.flat()),...chunk("IDAT",deflate),...chunk("IEND",[])]);
}
if(typeof module!=="undefined"&&require.main===module){
 const fs=require("node:fs"),path=require("node:path");
 for(const [file,size] of [["icon-192.png",192],["icon-512.png",512],["icon-512-maskable.png",512],["apple-touch-icon.png",180]])
  fs.writeFileSync(path.join(__dirname,"../icons",file),appIconPNG(size));
}
