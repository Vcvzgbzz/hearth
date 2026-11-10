/**
 * A slice of rising smoke, lit by a fanned sheet of light and drawn in ASCII,
 * behind the Scheduler, Models, Keys and Lending pages. The busier the node, the
 * thicker and quicker it rises, the warmer the coals glow under it, and the
 * more embers come off them.
 * WebGL2 in two passes: the first works out, for each character cell, how
 * bright the lit smoke is, how hot the coals are and whether an ember is
 * passing; the second draws each cell's glyph from a small atlas, the smoke
 * in the page's greys warmed by the fire, the coals and embers in its colours.
 * The node's name seeds it, so every node burns its own way and the same way
 * each time. A wind drifts it, stronger the busier the node, with a gust when
 * the load jumps; the pointer parts it a little as it passes; each request that
 * finishes sends one spark off the coals; a click on its empty floor stokes it,
 * a flare and a few sparks where the click landed. None of that touches the
 * node. No WebGL2, no smoke; with reduced motion, one still frame that nothing
 * moves.
 */
import { useEffect, useRef } from "react";
import { fire, seedOf } from "./fire.js";
import { useStore } from "./store.js";
import type { UiData } from "../observe/uidata.js";

// Least ink first. The smoke is punctuation only: anything heavier clumps into blocks where it is
// dense and fights the page, and a dash reads as a ruled line. The fire ends in two shades, so
// only its hottest cells go solid.
const SMOKE = " ·,:;~=+*";
const FIRE = " ·,:;~=+*░▒";
// An ember's glyph by age, least ink first: a round spark as it leaves the coals, hollow as it
// cools, a speck as it goes out.
const EMBER = "·◦*•";
// The faintest step of either ramp is a speck high, mid or low in its cell, picked per cell, so
// thin haze does not line up in rows.
const SPECK = "˙·.";
// A drop of rain, and the flakes of ash: small rings and dot pairs that read as neither smoke nor ember.
const RAIN = "'";
const ASH = "˙¨˚°";
const CELL_W = 8;
const CELL_H = 14;
const FONT_PX = 12;
const GAIN = 2.1;
const STILL_T = 40;

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<4;i++){s+=a*snoise(p);p*=2.03;a*=0.5;}return s;}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
`;

const VS = "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";

// One texel per cell, all 0..1: r = the sheet-lit smoke, g = the fire-lit smoke, b = a passing thing's
// brightness and a = its kind in the top two bits (fire ember, peer ember, raindrop, ash) with its age
// in the rest, or the cell's heat when nothing passes. uLoad is how busy the node is, uHeat and
// uEmbers its fire, uSeed the node's own noise slice, light, flicker, coals and embers. uStoke holds
// the last twelve stokes, each (cell x, cell y, when, kind): 1 a click, 0.5 a finished request, 0.4
// a request in from a peer, 0.3 one sent out to a peer, 0.2 a failed request. uDrift is how far the
// wind has carried the smoke, uWind its strength now, uCursor the pointer (cell x, cell y, speed),
// uThin how far the fire has ashed over idle, uAsh how much ash is falling after a load fell away.
const FS_DENSITY = `#version 300 es
precision highp float;
uniform vec2 uGrid; uniform vec2 uCell; uniform float uT; uniform float uRise; uniform float uLoad;
uniform float uHeat; uniform float uEmbers; uniform vec4 uSeed; uniform vec4 uStoke[12];
uniform float uDrift; uniform float uWind; uniform vec3 uCursor; uniform float uThin; uniform float uAsh;
out vec4 o;
${NOISE}
const float LANE=5.0; const float CYCLE=5.6;
const float STOKE=2.6; const float SPARK=2.2;
void main(){
  vec2 c=vec2(gl_FragCoord.x,uGrid.y-gl_FragCoord.y);
  vec2 px=c*uCell; vec2 size=uGrid*uCell; float t=uT;
  // Embers: every LANE cells may send one up each CYCLE, on its own phase, two cycles checked since
  // one may outlive its cycle. Each climbs its own height at its own pace, cooling and shrinking only
  // once clear of the fire, leaves a fainter speck in the cells it passed, and lifts the smoke near it.
  float ember=0.0, age=0.0, kind=0.0, lift=0.0;
  float lane0=floor(c.x/LANE), fireTop=0.35*uGrid.y;
  for(int i=-1;i<=1;i++){
    float lane=lane0+float(i);
    float tt=t+hash(vec2(lane,7.0+uSeed.x*100.0))*CYCLE;
    for(int g=0;g<2;g++){
      float cyc=floor(tt/CYCLE)-float(g);
      float born=tt-cyc*CYCLE;
      if(hash(vec2(lane,cyc)+uSeed.yz*50.0)>uEmbers) continue;
      float h=hash(vec2(cyc,lane)+uSeed.wx*50.0);
      float h3=hash(vec2(lane*3.1,cyc*1.7)+uSeed.zw*20.0);
      float climb=uGrid.y*(0.11+0.09*h)*(0.85+0.3*uSeed.y), reach=uGrid.y*(0.5+0.45*h3), wander=0.8+1.4*uSeed.z;
      if(born*climb>=reach) continue;
      for(int k=0;k<4;k++){
        float ago=born-float(k)*0.12;
        if(ago<0.0) break;
        float up=ago*climb;
        float u=smoothstep(fireTop,reach,up);
        float ex=(lane+h)*LANE+sin(ago*(2.0+2.0*h)+h*6.28)*wander+uWind*3.0*ago;
        float ey=uGrid.y-0.5-h*3.0-up;
        if(k==0){
          float dx=c.x+0.5-ex, dy=c.y+0.5-ey;
          float w=exp(-dx*dx/6.0)*(dy>0.0?exp(-dy*dy/40.0):exp(-dy*dy/2.0));
          lift+=0.12*w*(1.0-u);
        }
        if(floor(ex)!=floor(c.x)||floor(ey)!=floor(c.y)) continue;
        // The glyph runs its course over the whole climb; the brightness holds until clear of the fire.
        float keep=k==0?1.0:0.4*pow(0.55,float(k-1));
        float b=keep*(1.0-u)*(0.8+0.2*sin(t*13.0+h*20.0))*(0.85+0.15*h3);
        if(b>ember){ember=b;age=k==0?up/reach:1.0;}
        break;
      }
    }
  }
  // The stokes, by kind. A click flares and lifts the smoke around it and six sparks leave it fanning
  // upward. A finished request sends one spark up from the coals; one that ran on a peer, or came in
  // from one, sends a blue-hot one, the outgoing drifting off the slice's edge. A failed request is a
  // drop of rain: it falls from the top and hisses where it meets the coals, cooling them for a moment
  // under a wisp of steam. Sparks climb their own height like embers; a click's burn for SPARK seconds.
  float stoke=0.0, steam=0.0;
  for(int s=0;s<12;s++){
    vec4 st=uStoke[s];
    float a=t-st.z;
    if(st.w<=0.0||a<0.0) continue;
    if(st.w<0.25){
      float fallSp=uGrid.y*0.45, landY=0.78*uGrid.y, yPos=fallSp*a;
      if(yPos<landY){
        float qx=st.x+sin(a*2.0+st.z)*0.4;
        if(floor(qx)==floor(c.x)&&floor(yPos)==floor(c.y)&&ember<0.9){ember=0.9;age=0.0;kind=2.0;}
      } else {
        float since=(yPos-landY)/fallSp;
        if(since<1.2){
          vec2 dp=(c-vec2(st.x,landY))*vec2(1.0,1.6);
          float hiss=exp(-dot(dp,dp)/10.0)*(1.0-since/1.2);
          stoke-=0.6*hiss; steam+=0.5*hiss; lift+=0.3*hiss;
        }
      }
      continue;
    }
    bool click=st.w>0.75, peer=st.w<0.45, outward=st.w<0.35;
    if(a>(click?STOKE:8.0)) continue;
    if(click){
      vec2 dp=(c-st.xy)*vec2(1.0,1.6);
      float ease=1.0-a/STOKE;
      float puff=exp(-dot(dp,dp)/18.0)*ease*ease;
      lift+=0.35*puff;
      stoke+=0.5*puff;
    }
    for(int k=0;k<6;k++){
      if(!click&&k>0) break;
      float h=hash(vec2(st.z*7.0+float(k),float(s)+1.0));
      float h2=hash(vec2(float(k)+0.5,st.z*3.0));
      float ang=1.5708+(h-0.5)*(click?1.4:0.5);
      float sp=click?5.0+6.0*h2:uGrid.y*(0.12+0.08*h2), reach=uGrid.y*(0.45+0.3*h2);
      vec2 vel=vec2(cos(ang),-sin(ang))*sp;
      if(outward) vel.x=(st.x<uGrid.x*0.5?-1.0:1.0)*uGrid.x*0.12;
      for(int j=0;j<3;j++){
        float ago=a-float(j)*0.12;
        if(ago<0.0||(click?ago>=SPARK:ago*sp>=reach)) break;
        vec2 q=st.xy+vel*ago+vec2(sin(ago*3.0+h*6.28)*0.6+uWind*3.0*ago,click?2.0*ago*ago:0.0);
        if(floor(q.x)!=floor(c.x)||floor(q.y)!=floor(c.y)) continue;
        float u=click?ago/SPARK:smoothstep(fireTop,reach,ago*sp);
        float keep=j==0?1.0:0.4*pow(0.55,float(j-1));
        float b=keep*(1.0-u)*(0.8+0.2*sin(t*13.0+h*20.0));
        if(b>ember){ember=b;age=j==0?(click?u:ago*sp/reach):1.0;kind=peer?1.0:0.0;}
        break;
      }
    }
  }
  // Ash: after a big load falls away, flakes drift down from the top for a while, slow and wavering,
  // in the smoke's grey; each lane may let one go per cycle, more of them the fresher the fall.
  if(uAsh>0.0){
    for(int i=-1;i<=1;i++){
      float lane=lane0+float(i);
      float tt=t+hash(vec2(lane,3.0+uSeed.y*70.0))*4.0;
      for(int g=0;g<3;g++){
        float cyc=floor(tt/4.0)-float(g);
        float born=tt-cyc*4.0;
        if(hash(vec2(lane*1.3,cyc)+uSeed.xw*40.0)>uAsh*0.5) continue;
        float h=hash(vec2(cyc*2.1,lane)+uSeed.zy*30.0);
        float fy=born*uGrid.y*(0.1+0.06*h)-1.0;
        if(fy>uGrid.y) continue;
        float fx=(lane+h)*LANE+sin(born*1.3+h*6.28)*1.2+uWind*2.0*born;
        if(floor(fx)!=floor(c.x)||floor(fy)!=floor(c.y)) continue;
        if(ember<0.6){ember=0.6;age=h;kind=3.0;}
      }
    }
  }
  // The pointer parts the smoke a little as it moves through; still, it does nothing.
  vec2 dc=(c-uCursor.xy)*vec2(1.0,1.6);
  lift+=0.18*uCursor.z*exp(-dot(dc,dc)/14.0);
  // Over the coals the air shimmers: a tiny wobble of the sample, more the hotter the fire.
  float y=c.y/uGrid.y;
  float band=smoothstep(0.45,1.0,y); band*=band;
  float shimmer=0.012*band*(0.5+uHeat)*sin(px.x/9.0+t*6.0+uSeed.y*6.0);
  // The wind has carried the smoke uDrift along by now.
  vec3 p=vec3(px/340.0+uSeed.xy*37.0+vec2(uDrift,0.0),t*0.03+uSeed.z*11.0); p.y+=uRise+lift+shimmer;
  vec3 q=vec3(fbm(p+vec3(0.0,0.0,1.7)),fbm(p+vec3(5.2,1.3,2.8)),0.0);
  float n=fbm(p+1.8*q);
  float wisps=1.0-abs(fbm(p*1.7+q));
  float lo=mix(0.42,0.28,uLoad)+0.08*uThin;
  float d=smoothstep(lo,0.9,n*0.65+0.45)*mix(0.45,1.0,wisps*wisps);
  vec2 v=px-vec2(-0.06*size.x,-0.18*size.y);
  float ang=atan(v.y,v.x);
  float aim=0.72+0.10*sin(t*0.21)+(uSeed.x-0.5)*0.3;
  // A bright core, then a dim tail that fades over a wide angle: no hard shadow beside the sheet.
  float off=abs(ang-aim);
  float fan=mix(0.22,1.0,1.0-smoothstep(0.22,0.5+(uSeed.y-0.5)*0.2,off))*(1.0-smoothstep(0.8,1.6,off));
  float ray=0.88+0.12*sin(ang*55.0+sin(t*0.5)*1.5);
  float r=length(v)/max(size.x,size.y); float fall=1.0/(1.0+r*r*1.1);
  // The bottom fade lifts as the fire builds, so dense smoke sits right over the coals.
  // Under the page header, where bare text can sit, the whole effect fades out over the first hundred
  // pixels, so no glyph runs through a line of text.
  float top=smoothstep(16.0,104.0,px.y);
  float fade=top*(1.0-smoothstep(0.75,1.0,y)*(1.0-0.6*uLoad));
  float smoke=d*fan*ray*fall*fade*mix(0.75,1.15,uLoad);
  // The coals: the bottom band, patchy with a slow noise of its own, flickering.
  float spots=0.55+0.45*(0.5+0.5*snoise(vec3(px.x/150.0+uSeed.w*50.0,px.y/70.0,t*0.07)));
  float flick=0.86+0.14*sin(t*(6.0+2.6*uSeed.z))*sin(t*(2.4+1.4*uSeed.w));
  float heat=clamp(band*spots*flick*uHeat+stoke,0.0,1.0);
  // The fire lights the smoke from below: the wisps nearest the coals take its colour. A stoke
  // lights even thin smoke, so the flare shows wherever the click lands, but never past a plus.
  float glow=(d*heat+max(stoke,0.0)*(0.25+0.5*d))*0.8*top;
  ember*=top;
  o=vec4(smoke+steam*0.6,glow,ember,ember>0.0?(kind*64.0+floor(age*63.0))/255.0:heat);
}`;

// Every pixel: which cell it is in and that cell's glyph from the atlas, in the page's greys where
// the sheet of light reaches it and in the fire's colours, red through orange to the tip, where
// the coals light it from below; an ember passing draws its glyph over either.
const FS_GLYPH = `#version 300 es
precision highp float;
uniform sampler2D uDensity; uniform sampler2D uAtlas; uniform vec2 uCellDev; uniform float uCanvasH;
uniform float uN; uniform float uNSmoke; uniform float uNFire; uniform float uNEmber; uniform float uNSpeck; uniform float uNRain; uniform float uNAsh;
uniform float uGain; uniform float uAlpha; uniform float uWarm;
uniform vec3 uDim; uniform vec3 uHot; uniform vec3 uRed; uniform vec3 uOrange; uniform vec3 uTip; uniform vec3 uBlue; uniform vec3 uPeer;
out vec4 o;
vec3 fireOf(float h){vec3 c=mix(uRed,uOrange,smoothstep(0.0,0.55,h));return mix(c,uTip,smoothstep(0.6,1.0,h));}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec2 f=vec2(gl_FragCoord.x,uCanvasH-gl_FragCoord.y);
  ivec2 cell=ivec2(floor(f/uCellDev)); ivec2 sz=textureSize(uDensity,0);
  vec4 d=texelFetch(uDensity,ivec2(cell.x,sz.y-1-cell.y),0);
  vec2 inC=fract(f/uCellDev);
  float gi; vec3 col; float a;
  if(d.b>0.0){
    // Something passing: its kind in the top two bits of the age channel, its age in the rest. An ember
    // leaves the coals orange and cools to red, never the tip's yellow; a peer's is blue-hot cooling
    // to the peer colour; a raindrop and a flake of ash are the smoke's own grey.
    float raw=floor(d.a*255.0+0.5), k=floor(raw/64.0), age=mod(raw,64.0)/63.0;
    float glyph=floor((1.0-age)*(uNEmber-1.0)+0.5);
    if(k<0.5){gi=uNSmoke+uNFire+glyph;col=fireOf(0.5-0.4*age);}
    else if(k<1.5){gi=uNSmoke+uNFire+glyph;col=mix(uBlue,uPeer,age);}
    else if(k<2.5){gi=uNSmoke+uNFire+uNEmber+uNSpeck;col=uDim;}
    else {gi=uNSmoke+uNFire+uNEmber+uNSpeck+uNRain+floor(age*(uNAsh-0.001));col=mix(uDim,uHot,0.3);}
    a=d.b*clamp(0.8+0.2*uWarm,0.0,1.0);
  } else {
    // The brighter of the two lights picks the glyph, from its own ramp; the cell's colour is
    // as much the fire's as the fire's share of its light.
    float s=clamp(d.r*uGain,0.0,1.0);
    float g=clamp(d.g*uGain,0.0,1.0);
    bool lit=g>s;
    float lvl=lit?g:s, n=lit?uNFire:uNSmoke, base=lit?uNSmoke:0.0;
    float step=floor(min(lvl,0.999)*n);
    if(step<1.0) discard;
    gi=step>1.0?base+step:uNSmoke+uNFire+uNEmber+floor(hash(vec2(cell))*uNSpeck);
    float warm=g/max(lvl,0.001);
    vec3 grey=mix(uDim,uHot,smoothstep(0.2,0.7,s));
    col=mix(grey,fireOf(d.a),warm);
    a=uAlpha*(0.35+0.65*lvl)*(1.0+uWarm*warm);
  }
  float alpha=texture(uAtlas,vec2((gi+inC.x)/uN,inC.y)).a*a;
  o=vec4(col*alpha,alpha);
}`;

type Program = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

function program(gl: WebGL2RenderingContext, fs: string): Program {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
    gl.attachShader(p, sh);
  }
  gl.bindAttribLocation(p, 0, "p");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const u: Program["u"] = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number; i < n; i++) {
    const name = gl.getActiveUniform(p, i)!.name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

/** The smoke behind a page: as busy as the node is, counting a backlog of twice its slots as full, and seeded by its name. */
export function NodeSmoke() {
  const jobs = useStore((s) => s.data?.q.jobs.length ?? 0);
  const slots = useStore((s) => s.data?.q.capacity.slots ?? 1);
  const name = useStore((s) => s.data?.net.nodes.find((n) => n.self)?.name ?? "");
  const recent = useStore((s) => s.data?.recent);
  return <Smoke load={jobs / Math.max(4, slots * 2)} seed={seedOf(name)} recent={recent} />;
}

/**
 * `load` is how busy the node is, 0 for idle to 1 for a full queue; it eases, so a burst does not
 * jolt. `seed` is the node's own four numbers in [0, 1). `recent` is the latest requests, newest
 * first; each new one sends something up: a spark, a blue one for a peer's, a raindrop for a failure.
 */
function Smoke({ load, seed, recent }: { load: number; seed: [number, number, number, number]; recent: UiData["recent"] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(load);
  target.current = Math.max(0, Math.min(1, load));
  const own = useRef(seed);
  own.current = seed;
  // The last twelve stokes, as (cell x, cell y, when, kind), oldest overwritten first: kind 1 is a
  // click, 0.5 a finished request, 0.4 one in from a peer, 0.3 one sent to a peer, 0.2 a failure.
  // The grid size rides along so a spark can start on the bottom row and a drop at the top.
  const ring = useRef({ v: new Float32Array(48), next: 0, cols: 1, rows: 1, sized: false }).current;
  const put = (x: number, y: number, kind: number) => {
    ring.v.set([x, y, performance.now() / 1000, kind], ring.next * 4);
    ring.next = (ring.next + 1) % 12;
  };
  // Each new request sends its thing, at most four per update, once the grid has been sized; the
  // newest success is when the fire last had work, which decides whether it has ashed over.
  const seen = useRef(0);
  const worked = useRef(Date.now());
  const catching = useRef(false);
  useEffect(() => {
    if (!recent?.length) return;
    if (seen.current && ring.sized) {
      for (let i = 0, n = 0; i < recent.length && recent[i]!.t > seen.current && n < 4; i++, n++) {
        const r = recent[i]!;
        // A request that ran and failed is rain; one refused before it ran, with nowhere it ran, is nothing.
        if (!r.ok) { if (r.backend || r.peer) put(Math.random() * ring.cols, 0, 0.2); }
        else if (r.peer) put(Math.random() * ring.cols, ring.rows - 0.5, 0.3);
        else if (r.caller.startsWith("peer:")) put(Math.random() * ring.cols, ring.rows - 0.5, 0.4);
        else put(Math.random() * ring.cols, ring.rows - 0.5, 0.5);
      }
    }
    const ok = recent.find((r) => r.ok);
    if (ok && ok.t > worked.current) { if (Date.now() - worked.current > 300_000) catching.current = true; worked.current = ok.t; }
    seen.current = recent[0]!.t;
  }, [recent]);

  useEffect(() => {
    const canvas = ref.current;
    const zone = canvas?.parentElement;
    const gl = canvas?.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    if (!canvas || !zone || !gl) return;
    let pD: Program, pG: Program;
    try { pD = program(gl, FS_DENSITY); pG = program(gl, FS_GLYPH); } catch { return; }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      return t;
    };
    const density = texture(), atlas = texture();
    const fb = gl.createFramebuffer();
    let cols = 1, rows = 1, cw = 1, ch = 1, dpr = 1;
    const GLYPHS = SMOKE + FIRE + EMBER + SPECK + RAIN + ASH;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = Math.max(1, Math.round(CELL_W * dpr));
      ch = Math.max(1, Math.round(CELL_H * dpr));
      canvas.width = Math.max(1, Math.round(zone.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(zone.clientHeight * dpr));
      cols = Math.ceil(canvas.width / cw);
      rows = Math.ceil(canvas.height / ch);
      ring.cols = cols;
      ring.rows = rows;
      ring.sized = true;
      gl.bindTexture(gl.TEXTURE_2D, density);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, density, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // The glyphs, white on transparent: only alpha is read. The smoke's and the fire's ramps go in
      // by their ink as this font draws it, least first, so every step is a step up in tone; the
      // ember's by age; the specks last.
      const a = document.createElement("canvas");
      a.width = cw * GLYPHS.length;
      a.height = ch;
      const x = a.getContext("2d", { willReadFrequently: true })!;
      x.fillStyle = "#fff";
      x.font = `${Math.round(FONT_PX * dpr)}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      const ink = (g: string) => {
        x.clearRect(0, 0, cw, ch);
        x.fillText(g, cw / 2, ch / 2 + dpr);
        const d = x.getImageData(0, 0, cw, ch).data;
        let s = 0;
        for (let i = 3; i < d.length; i += 4) s += d[i]!;
        return s;
      };
      const byInk = (set: string) => [...set].map((g) => [g, ink(g)] as const).sort((p, q) => p[1] - q[1]).map((p) => p[0]).join("");
      const glyphs = byInk(SMOKE) + byInk(FIRE) + EMBER + SPECK + RAIN + ASH;
      x.clearRect(0, 0, a.width, a.height);
      for (let i = 1; i < glyphs.length; i++) x.fillText(glyphs[i]!, i * cw + cw / 2, ch / 2 + dpr);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
    };

    // The theme's own colours, as 0..1 RGB: the thin smoke in --dim, the dense halfway to --fg,
    // and the fire from --bad through the ember accent to --warn. On a light page the greys lean
    // further toward --fg and the fire deepens, so both hold up against the pale background.
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.canvas.width = probe.canvas.height = 1;
    // A colour the canvas cannot read leaves the sentinel in place; that, or an empty
    // variable, gives the fallback, so a missing theme colour never draws invisible smoke.
    const SENTINEL = "#010203";
    const rgb = (css: string, fallback: [number, number, number]): [number, number, number] => {
      if (!css) return fallback;
      probe.fillStyle = SENTINEL;
      probe.fillStyle = css;
      if (probe.fillStyle === SENTINEL) return fallback;
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
    };
    type RGB = [number, number, number];
    const GREY: RGB = [0.55, 0.55, 0.55];
    let dim = GREY, hot = GREY, alpha = 0.4, warm = 0.5;
    let red: RGB = [0.72, 0.25, 0.2], orange: RGB = [0.9, 0.5, 0.2], tip: RGB = [0.95, 0.75, 0.4];
    let blue: RGB = [0.6, 0.75, 1], peer: RGB = [0.7, 0.45, 0.9];
    const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as RGB;
    const colours = () => {
      const s = getComputedStyle(document.documentElement);
      const v = (name: string) => s.getPropertyValue(name).trim();
      const bg = rgb(v("--bg"), [0.5, 0.5, 0.5]);
      const dark = (bg[0] + bg[1] + bg[2]) / 3 < 0.5;
      const fg = rgb(v("--fg"), [0.75, 0.75, 0.75]);
      dim = mix(rgb(v("--dim"), GREY), fg, dark ? 0 : 0.25);
      hot = mix(dim, fg, dark ? 0.55 : 0.75);
      const deepen = (c: RGB): RGB => (dark ? c : mix(c, [0, 0, 0], 0.28));
      red = deepen(rgb(v("--bad"), red));
      orange = deepen(rgb(v("--accent"), orange));
      tip = deepen(rgb(v("--warn"), tip));
      // A peer's ember starts blue-hot, --info pushed toward white on a dark page, and cools to --peer.
      blue = deepen(mix(rgb(v("--info"), blue), [1, 1, 1], dark ? 0.45 : 0));
      peer = deepen(rgb(v("--peer"), peer));
      alpha = dark ? 0.42 : 0.4;
      warm = dark ? 0.5 : 1.5;
    };

    // Where the pointer is, in cells, and how fast it has been moving, 0..1; a click on the floor
    // stokes. The floor is the zone itself or a child marked data-smoke="floor"; cards and controls
    // never count.
    const cell = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / CELL_W, (e.clientY - r.top) / CELL_H];
    };
    const cursor = { x: -99, y: -99, s: 0, lt: 0 };
    const stoke = (e: PointerEvent) => {
      const at = e.target as HTMLElement | null;
      if (still || !at || (at !== zone && !(at.parentElement === zone && at.dataset.smoke === "floor"))) return;
      put(...cell(e), 1);
    };
    const move = (e: PointerEvent) => {
      if (still) return;
      const [x, y] = cell(e), now = performance.now() / 1000;
      if (cursor.lt && now > cursor.lt) cursor.s = Math.max(cursor.s, Math.min(1, Math.hypot(x - cursor.x, y - cursor.y) / (now - cursor.lt) / 300));
      cursor.x = x;
      cursor.y = y;
      cursor.lt = now;
    };
    const leave = () => { cursor.s = 0; cursor.lt = 0; };

    // The whole hearth stoked at once, from the flame in the corner: a glow across the coals and a few sparks.
    const stokeAll = () => {
      if (still) return;
      for (let i = 0; i < 4; i++) put(Math.random() * ring.cols, ring.rows - 0.5, 0.5);
      catchUp = Math.max(catchUp, 0.6);
    };

    let load = target.current, rise = 0, lastT = 0, drift = 0, gust = 0, seenLoad = target.current;
    let ashed = 0, catchUp = 0, peak = 0, ash = 0;
    const draw = (t: number) => {
      // Ease toward the queue's load, and let the smoke climb faster the busier it is.
      const dt = lastT ? Math.min(0.1, t - lastT) : 0;
      lastT = t;
      load += (target.current - load) * Math.min(1, dt * 1.5);
      rise += dt * (0.05 + 0.09 * load);
      // The wind: a slow wander of the node's own, stronger the busier it is, and a gust whenever the
      // load jumps; it carries the smoke sideways and leans the embers. The pointer's wake dies down.
      const breeze = 0.6 * Math.sin(t * 0.05 + own.current[3] * 6.28) + 0.4 * Math.sin(t * 0.013 + own.current[2] * 4);
      gust = Math.max(0, gust - dt * 0.6) + Math.max(0, target.current - seenLoad) * 3;
      seenLoad = target.current;
      const wind = breeze * (0.25 + 0.75 * load) + Math.min(1, gust) * (breeze < 0 ? -1 : 1);
      drift += dt * wind * 0.08;
      cursor.s *= Math.exp(-dt * 3);
      // Five minutes with no work and the fire ashes over, slowly; the first work after that catches it
      // again with a short glow across the coals. Ash falls for a while after a big load falls away.
      ashed += ((Date.now() - worked.current > 300_000 ? 1 : 0) - ashed) * Math.min(1, dt * 0.05);
      if (catching.current) { catching.current = false; catchUp = 1; }
      catchUp = Math.max(0, catchUp - dt / 2);
      peak = Math.max(load, peak - dt * 0.01);
      ash += (Math.max(0, Math.min(1, (peak - load - 0.25) * 2.5)) - ash) * Math.min(1, dt * 0.5);
      const fired = fire(load);
      const heat = Math.min(1, fired.heat * (1 - 0.6 * ashed) + 0.5 * catchUp);
      const embers = fired.embers;
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, cols, rows);
      gl.useProgram(pD.p);
      gl.uniform2f(pD.u.uGrid!, cols, rows);
      gl.uniform2f(pD.u.uCell!, cw / dpr, ch / dpr);
      gl.uniform1f(pD.u.uT!, t);
      gl.uniform1f(pD.u.uRise!, still ? STILL_T * 0.05 : rise);
      gl.uniform1f(pD.u.uLoad!, load);
      gl.uniform1f(pD.u.uHeat!, heat);
      gl.uniform1f(pD.u.uEmbers!, embers);
      gl.uniform4fv(pD.u.uSeed!, own.current);
      gl.uniform4fv(pD.u["uStoke[0]"]!, ring.v);
      gl.uniform1f(pD.u.uDrift!, drift);
      gl.uniform1f(pD.u.uWind!, wind);
      gl.uniform3f(pD.u.uCursor!, cursor.x, cursor.y, cursor.s);
      gl.uniform1f(pD.u.uThin!, ashed);
      gl.uniform1f(pD.u.uAsh!, ash);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pG.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, density);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(pG.u.uDensity!, 0);
      gl.uniform1i(pG.u.uAtlas!, 1);
      gl.uniform2f(pG.u.uCellDev!, cw, ch);
      gl.uniform1f(pG.u.uCanvasH!, canvas.height);
      gl.uniform1f(pG.u.uN!, GLYPHS.length);
      gl.uniform1f(pG.u.uNSmoke!, SMOKE.length);
      gl.uniform1f(pG.u.uNFire!, FIRE.length);
      gl.uniform1f(pG.u.uNEmber!, EMBER.length);
      gl.uniform1f(pG.u.uNSpeck!, SPECK.length);
      gl.uniform1f(pG.u.uNRain!, RAIN.length);
      gl.uniform1f(pG.u.uNAsh!, ASH.length);
      gl.uniform3fv(pG.u.uBlue!, blue);
      gl.uniform3fv(pG.u.uPeer!, peer);
      gl.uniform1f(pG.u.uGain!, GAIN);
      gl.uniform1f(pG.u.uAlpha!, alpha);
      gl.uniform1f(pG.u.uWarm!, warm);
      gl.uniform3fv(pG.u.uDim!, dim);
      gl.uniform3fv(pG.u.uHot!, hot);
      gl.uniform3fv(pG.u.uRed!, red);
      gl.uniform3fv(pG.u.uOrange!, orange);
      gl.uniform3fv(pG.u.uTip!, tip);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // About 30 frames a second, and nothing while the tab is hidden.
    let raf = 0, last = 0;
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      if (now - last >= 33) { last = now; draw(now / 1000); }
      raf = requestAnimationFrame(frame);
    };
    const wake = () => { if (still) draw(STILL_T); else if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };
    const redraw = () => { if (still) draw(STILL_T); };

    resize();
    colours();
    wake();
    const sized = new ResizeObserver(() => { resize(); redraw(); });
    sized.observe(zone);
    // The theme toggle flips a class on <html>; the colours follow it.
    const themed = new MutationObserver(() => { colours(); redraw(); });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", wake);
    zone.addEventListener("pointerdown", stoke);
    zone.addEventListener("pointermove", move);
    zone.addEventListener("pointerleave", leave);
    window.addEventListener("hearth-stoke", stokeAll);
    return () => {
      cancelAnimationFrame(raf);
      sized.disconnect();
      themed.disconnect();
      document.removeEventListener("visibilitychange", wake);
      zone.removeEventListener("pointerdown", stoke);
      zone.removeEventListener("pointermove", move);
      zone.removeEventListener("pointerleave", leave);
      window.removeEventListener("hearth-stoke", stokeAll);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
