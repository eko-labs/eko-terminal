// Original EKO optical renderer, recovered from the user's public EKO landing.
// Source: the original hosted EKO research page (recovered 2026-10-04).
// Shaders, glyph generation, timeline and render passes retained unchanged.
// The React adapter uses the original scroll mapping in a fullscreen intro scroller.

const vertex = `#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`,
  world = `#version 300 es
precision highp float;
in vec2 uv;out vec4 outColor;
uniform sampler2D glyphs,marks;
uniform vec2 center,pointer;
uniform float pointerForce,reveal,interference,portal,dive,converge,swarm,nano,wordVisibility,vapor;
uniform float weights[16];
uniform vec2 typeOffset;
uniform float typeScale,planes,evidence,detail,lock,sampling,dropout,activeAgent,grooves;
uniform float surface,fieldLine,fieldProgress,fieldTuning,fieldFlash;
uniform float readingWeights[5];
uniform vec2 size;
uniform float time,phase,progress,morph,wordA,wordB,shape,paper,motion,stretch,spread,focus,link,fieldScale,zoom;
const float PI=3.14159265359;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float f=0.,a=.5;mat2 r=mat2(.8,-.6,.6,.8);for(int i=0;i<4;i++){f+=a*noise(p);p=r*p*2.03+vec2(17.1,9.7);a*=.5;}return f;}
mat2 rotate(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
// Keep the vapor in glyph units when the viewport is tall and narrow.
float typeUnit(){return min(1.,(size.x/size.y)/1.6);}
float txt(vec2 p,float index){
 float fit=min(1.,size.x/size.y/2.35);
 vec2 q=p/fit/vec2(4.8,2.4)+.5;
 if(q.x<0.||q.x>1.||q.y<0.||q.y>1.)return .8+length(max(abs(q-.5)-.5,0.));
 vec2 cell=vec2(mod(index,4.),floor(index/4.));
 // Linear sampling must stay within its glyph cell: neighboring glyphs are
 // uploaded independently, and must never change this word's vapor outline.
 vec2 local=clamp(vec2(q.x,1.-q.y),vec2(.5/256.,.5/128.),vec2(1.-.5/256.,1.-.5/128.));
 vec2 at=(cell+local)/vec2(4.,4.);
 float d=(texture(glyphs,at).r-.5)*64.*4.8/256.*fit;
 return d;
}
vec2 distort(vec2 p){
 vec2 q=p;
 vec2 mouse=(pointer-.5-center)*vec2(size.x/size.y,1.)*2.;
 vec2 delta=p-mouse;
 q+=delta*exp(-dot(delta,delta)*5.)*pointerForce*.28;
 float unit=typeUnit();
 q+=(vec2(fbm(p*2.5/unit+time*.17),fbm(p*2.5/unit-3.1-time*.21))*(.16+vapor*.65)-(.08+vapor*.325))*unit;
 q.x+=(sin(p.y*6./unit+time*1.2)*(.016+.075*sin(PI*morph))+sin(p.y*21./unit-time*2.)*.008)*unit;
 q.y+=sin(p.x*5./unit-time*1.6)*.026*unit;
 return q;
}
float smoothUnion(float a,float b,float k){float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float typeField(vec2 p){
 vec2 q=distort((p-typeOffset)*typeScale);q=rotate(.015*sin(time))*q;
 float fit=min(1.,size.x/size.y/2.35);
 float column=floor(clamp(p.x/fit/4.75+.5,0.,.999)*5.);
 q.x-=sin(p.y*4.+column*.7+time*.24)*.065*planes*fit;
 q.y+=(column-2.)*.016*planes;
 float linear=0.,fluid=10.;
 for(int i=0;i<16;i++){
  float w=weights[i];
  if(w>.00001){
   float d=txt(q,float(i));linear+=d*w;
   // Low-weight shapes enter from a distant field, never as a hard outline.
   fluid=smoothUnion(fluid,d+.13*typeUnit()*(1.-w)/max(w,.001),(.1+vapor*.25)*typeUnit());
  }
 }
 float d=mix(linear,fluid,vapor*.62);
 d+=(fbm(q*24./typeUnit()+vec2(time*.11,0.))-.48)*.014*typeUnit();
 d+=(noise(q*150./typeUnit())-.5)*.002*typeUnit();
 return d;
}
// Transmitted phosphor, not a reflective solid. Texture modulates opacity;
// broad light blooms through it without metallic normals or specular highlights.
vec3 inkMaterial(vec2 p,float d){
 float cloud=fbm(p*1.65+vec2(time*.07,-time*.09))*.58+fbm(p*4.1+time*.03)*.42;
 float dye=fbm(p*12.+time*.025);
 float front=.5+.5*sin(p.x*1.8-time*.52+cloud*2.);
 float density=pow(smoothstep(.24,.70,cloud),1.65);
 vec3 body=mix(vec3(.11,.26,.39),vec3(1.12,1.36,1.52),density);
 body*=.75+front*.28;
 return body*(.92+dye*.12);
}
vec4 typeScene(vec2 p){
 float d=typeField(p);
 float aa=(.012+vapor*.058)*typeUnit();
 float inside=1.-smoothstep(-aa,aa,d);
 float breakup=fbm(p*7.+time*.07)*.58+noise(p*68.)*.28;
 inside*=smoothstep(breakup-.12,breakup+.25,reveal)*(.88+fbm(p*6.-time*.05)*.12);
 float etch=exp(-abs(d)*18.)*.035*wordVisibility;
 vec3 object=inkMaterial(p,d);
 float pigment=fbm(p*9.);
 vec3 bg=mix(vec3(.009,.019,.033),vec3(.037,.10,.16),pow(pigment,3.));
 vec3 stock=vec3(.68,.82,.86)*(1.-noise(p*140.)*.08)-(fbm(p*5.)-.5)*.16;
 bg=mix(bg,stock,paper);
 object=mix(object,vec3(.005,.021,.037)+object*.12,paper);
 inside*=wordVisibility;
 float mist=exp(-abs(d)*7./typeUnit())*vapor*wordVisibility;
 object=mix(object,vec3(.14,.35,.51)+object*.35,vapor*.65);
 vec3 col=mix(bg,object,inside)+vec3(.19,.43,.65)*mist+vec3(.47,.78,1.)*etch*mix(.28,.12,paper);
 float emission=clamp((object.r+object.g+object.b)/3.-.16,0.,1.)*inside+etch*.30+mist*.35;
 return vec4(col,emission);
}
vec4 moireScene(vec2 p){
 vec2 mouse=(pointer-.5-center)*vec2(size.x/size.y,1.)*2.;
 vec2 q=(p+mouse*.09*pointerForce)*exp(-dive*.12);
 q=rotate(dive*.07)*q;
 float r=length(q+vec2(.08*sin(time*.3),0.));
 float a=sin(r*155.+sin(q.y*4.-time*.5)*2.);
 float b=sin(length(q*vec2(1.022,.979)+vec2(.021,.016))*157.);
 float beat=pow(.5+.5*a*b,3.);
 float light=pow(.5+.5*sin((r+time*.04)*12.),12.);
 vec3 color=vec3(.009,.020,.035)+vec3(.42,.75,1.05)*beat*(.27+light*.95);
 color+=vec3(.45,.77,1.)*exp(-length(q-mouse)*9.)*pointerForce*.2;
 return vec4(color,beat*light*.48);
}
// A quieter version of the opening's vinyl texture carries across the story.
vec4 grooveField(vec2 p){
 vec2 q=p-vec2(.70,.03);q*=vec2(.82,1.);
 float r=length(q),etch=.5+.5*sin(r*182.+sin(q.y*3.5+time*.06)*.65);
 float interference=.5+.5*sin(length(q*vec2(1.018,.985)+vec2(.008,.006))*179.);
 float bands=pow(etch*interference,2.4);
 float wash=.22+.58*pow(.5+.5*sin(r*5.-time*.14),4.);
 float mask=1.-smoothstep(2.,3.6,r);
 float intensity=bands*wash*mask;
 return vec4(vec3(.19,.43,.65)*intensity,intensity*.08);
}
// The film's interference settles into the margins of the working interface.
// Its light line is registered to the token controls, not an arbitrary overlay.
vec4 surfaceField(vec2 p){
 vec2 mouse=(pointer-.5)*vec2(size.x/size.y,1.);
 vec2 q=p-vec2(size.x/size.y*.91,.16);
 q=rotate(fieldProgress*.055+fieldTuning*.035)*q;
 q+=mouse*pointerForce*.045;
 float r=length(q*vec2(.88,1.));
 float a=.5+.5*sin(r*138.-fieldProgress*7.);
 float b=.5+.5*sin(length(q*vec2(1.023,.981)+vec2(.018,.012))*141.+fieldTuning*.3);
 float bands=pow(a*b,2.6);
 float exposure=.25+.75*pow(.5+.5*sin(r*5.-fieldProgress*3.),6.);
 float margin=smoothstep(.54,.94,uv.x);
 float edge=bands*exposure*margin;
 float gap=abs(uv.y-fieldLine);
 float horizontal=smoothstep(.035,.11,uv.x)*(1.-smoothstep(.90,.975,uv.x));
 float scan=0.;
 for(int i=0;i<5;i++){
  float x=.15+float(i)*.17;
  scan+=exp(-pow(abs((uv.x-x)/.045),2.))*readingWeights[i];
 }
 float grain=fbm(vec2(uv.x*24.+fieldTuning,uv.y*170.-fieldProgress));
 float beam=exp(-gap*620.)*(.22+scan*.55);
 float bleed=exp(-gap*85.)*pow(grain,3.)*(.18+scan*.34);
 // Indigo emulsion and a restrained cold film-burn live outside the text.
 float emulsion=fbm(p*3.7+vec2(fieldProgress*.2,0.));
 float burn=exp(-length((p-vec2(-size.x/size.y*.70,-.10))*vec2(1.,.6))*5.)*pow(emulsion,3.);
 vec3 color=vec3(.39,.47,.88)*edge*.52;
 color+=vec3(.26,.31,.60)*burn*.10;
 color+=vec3(.57,.65,.97)*(beam+bleed)*horizontal*(.8+fieldFlash*.65);
 return vec4(color,clamp(edge*.22+beam*.40+bleed*.20,0.,1.));
}
// The screen acquires depth: interference rings become a perspective conduit.
vec4 screenPassage(vec2 p){
 vec2 mouse=(pointer-.5)*vec2(size.x/size.y,1.);
 vec2 q=rotate(dive*.055)*(p+mouse*.12*pointerForce);
 float r=length(q)+.002,a=atan(q.y,q.x);
 float z=-log(r)*1.7+dive;
 float curl=fbm(q*3.+time*.12);
 float rings=pow(.5+.5*sin(z*16.+curl*2.5),12.);
 float offset=pow(.5+.5*sin(z*16.3+sin(a*2.)*.7+1.2),14.);
 float strands=pow(abs(sin(a*96.+z*.7)),35.);
 float fall=smoothstep(.025,.14,r)*(1.-smoothstep(1.5,3.2,r));
 float beam=(rings*.8+offset*.55+strands*.14)*fall;
 vec3 col=vec3(.009,.019,.034)+beam*vec3(.72,1.26,1.64);
 col+=offset*fall*vec3(.22,.14,.28)*.35;
 return vec4(col,beam*.7);
}
vec4 particlePassage(vec2 p){
 vec3 col=vec3(0.);float energy=0.;
 for(int i=0;i<42;i++){
  float id=float(i),seed=hash(vec2(id,3.7));
  float z=fract(seed+dive*.085+time*.006);
  float fade=smoothstep(0.,.12,z)*(1.-smoothstep(.80,1.,z));
  vec2 xy=vec2(hash(vec2(id,9.1)),hash(vec2(id,17.3)))*2.-1.;
  xy*=vec2(1.6,1.1);xy/=max(.11,z);
  xy=rotate(dive*.055)*xy;
  vec2 delta=p-xy;
  float point=exp(-length(delta)*mix(180.,50.,1.-z));
  float tail=exp(-length(delta*vec2(1.,3.))*36.)*.08;
  float spark=(point+tail)*fade;
  col+=vec3(.48,.78,1.)*spark*1.6;energy+=spark;
 }
 return vec4(col,energy);
}
vec4 lockField(vec2 p){
 float y=p.y-(1.-lock)*(.15*sin(p.x*3.-time*.6)+.06*sin(p.x*12.+time));
 float line=exp(-abs(y)*mix(13.,95.,lock));
 float strands=pow(.5+.5*sin(y*190.+p.x*4.+time),24.)*exp(-abs(y)*12.)*(1.-lock);
 float envelope=(1.-smoothstep(1.,2.9,p.x))*(.45+.55*smoothstep(-2.,.8,p.x));
 return vec4(vec3(.28,.56,.76)*(line*.45+strands*.6)*envelope,(line*.4+strands*.5)*envelope);
}
void main(){
 vec2 p=(uv-.5-center)*vec2(size.x/size.y,1.)*2.;
 p*=(1.+motion*.08)*zoom;
 p+=vec2(sin(time*.48),cos(time*.37))*.009;
 vec4 color;
 if(wordVisibility>.001)color=typeScene(p);
 else color=vec4(mix(vec3(.009,.019,.033),vec3(.037,.10,.16),pow(fbm(p*9.),3.)),0.);
 if(surface>.001)color+=surfaceField(p)*surface;
 if(grooves*(1.-portal)>.001)color+=grooveField(p)*grooves*(1.-portal);
 if(interference>.001){
  vec4 field=moireScene(p);
  float ink=wordVisibility>.001?(1.-smoothstep(-.01,(.05+vapor*.08)*typeUnit(),typeField(p)))*wordVisibility:0.;
  color=mix(color,field,interference*(1.-ink));
 }
 if(portal>.001){color=mix(color,screenPassage(p),portal);color+=particlePassage(p)*portal*.65;}
 if(lock>.001){
  float advance=smoothstep(-2.,2.,p.x+(lock-.5)*5.);
  color.rgb*=mix(1.,advance,lock*(1.-smoothstep(104.,110.,time/.32)));
  color+=lockField(p)*lock*(1.-smoothstep(104.,110.,time/.32));
 }
 if(sampling>.001){
  float scan=exp(-abs(p.y-.30+sampling*.45)*8.);
  float lattice=pow(.5+.5*sin(p.x*90.),25.)*pow(.5+.5*sin(p.y*90.),25.);
  color.rgb+=vec3(.25,.46,.61)*lattice*sampling*scan*.55;
 }
 if(dropout>.001){
  float gate=smoothstep(.35,.48,.5+.5*sin(p.y*21.+time*.9));
  color.rgb*=mix(1.,gate*.56,dropout);color.a*=mix(1.,gate,dropout);
 }
 float fog=fbm(p*2.8+vec2(time*.09,-time*.13));
 float plume=exp(-dot(p*vec2(.7,1.3),p*vec2(.7,1.3))*.8)*pow(fog,3.);
 color.rgb+=vec3(.23,.45,.67)*plume*(portal*.45+vapor*.7);
 color.a+=plume*(portal+vapor)*.2;
 float micro=noise(p*size.y*.7);
 color.rgb*=.95+micro*.10;
 vec4 inkMarks=texture(marks,vec2(uv.x,1.-uv.y));
 color.rgb+=inkMarks.rgb*inkMarks.a*1.6;color.a=max(color.a,inkMarks.a*.8);
 outColor=vec4(max(vec3(0.),color.rgb),clamp(color.a,0.,1.));
}`,
  combine = `#version 300 es
precision highp float;in vec2 uv;out vec4 outColor;
uniform sampler2D frame0,frame1,frame2,frame3;
uniform float trails,time,motion;
vec2 history(vec2 p,float age){
 vec2 q=p-.5;float a=age*(.008+.018*motion)*sin(time*.9);
 q=mat2(cos(a),-sin(a),sin(a),cos(a))*q;
 q*=1.+age*.012*motion;
 q.x+=sin(q.y*8.+time)*age*.004*motion;
 return q+.5+vec2(age*.004*motion,0.);
}
void main(){
 vec4 a=texture(frame0,uv),b=texture(frame1,history(uv,1.)),c=texture(frame2,history(uv,2.)),d=texture(frame3,history(uv,3.));
 vec3 residual=b.rgb*b.a*vec3(.48,.87,1.10)*.45+c.rgb*c.a*vec3(.34,.81,1.22)*.32+d.rgb*d.a*vec3(.58,.73,1.18)*.23;
 vec3 v=a.rgb+residual*trails;
 outColor=vec4(v,max(a.a,(b.a+c.a+d.a)*.22));
}`,
  blur = `#version 300 es
precision highp float;in vec2 uv;out vec4 outColor;
uniform sampler2D source;uniform vec2 direction;uniform float extract;
vec3 sampleColor(vec2 p){vec4 s=texture(source,p);return extract>.5?max(s.rgb-.60,0.)*s.a:s.rgb;}
void main(){
 vec3 v=sampleColor(uv)*.227027;
 v+=(sampleColor(uv+direction*1.384615)+sampleColor(uv-direction*1.384615))*.316216;
 v+=(sampleColor(uv+direction*3.230769)+sampleColor(uv-direction*3.230769))*.070270;
 outColor=vec4(v,1.);
}`,
  finish = `#version 300 es
precision highp float;in vec2 uv;out vec4 outColor;
uniform sampler2D source,halo,wideHalo;
uniform vec2 size;uniform float time,bloom,grain,chromatic,crt,motion,pulse,nano,dive,dither,filmWear,dropout,portal;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
vec3 smear(vec2 p){
 vec2 vector=(p-.5)*motion*.055+vec2(.013,-.003)*motion;
 vec3 v=vec3(0.);float w=0.;
 for(int i=0;i<6;i++){float k=float(i)/5.,weight=1.-k*.75;v+=texture(source,p-vector*k).rgb*weight;w+=weight;}
 return v/w;
}
float bayer(vec2 position){
 ivec2 cell=ivec2(mod(floor(position),4.));
 const int matrix[16]=int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
 return (float(matrix[cell.y*4+cell.x])+.5)/16.;
}
void main(){
 vec2 p=uv,q=p-.5;
 float safeFrame=smoothstep(0.,.12,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));
 p=.5+q*(1.+dot(q,q)*.055*crt*safeFrame);
 float sweep=fract(time*.11+.32);
 float tracking=exp(-abs(p.y-sweep)*220.);
 float dropout=pow(max(0.,sin(time*1.2)),24.);
 p.x+=(noise(vec2(floor(p.y*190.),floor(time*12.)))-.5)*.0012*crt;
 p.x+=tracking*dropout*.034*crt;
 float edgeDistance=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));
 float edgeSafe=smoothstep(0.,.07,edgeDistance);
 vec2 split=((p-.5)*(.011+nano*.012)*chromatic+vec2(.0015,-.0005)*chromatic)*edgeSafe;
 vec3 r=smear(p+split),g=smear(p),b=smear(p-split);
 vec3 splitColor=vec3(r.r,g.g,b.b);
 vec3 col=mix(texture(source,p).rgb,splitColor,.55+min(.4,motion*.30));
 // A magnified phosphor lattice resolves into individual RGB emitters during the dive.
 vec2 cell=fract(p*size/(2.+nano*4.));
 float emitter=smoothstep(.02,.20,cell.x)*(1.-smoothstep(.78,.98,cell.x));
 emitter*=smoothstep(.04,.25,cell.y)*(1.-smoothstep(.7,.96,cell.y));
 float subpixel=mod(floor(p.x*size.x/(2.+nano*4.)),3.);
 vec3 led=subpixel<1.?vec3(1.45,.60,.55):subpixel<2.?vec3(.55,1.4,.60):vec3(.60,.70,1.55);
 col*=mix(vec3(1.),led*(.58+emitter*.6),nano*.42);
 col*=1.04+pulse*.64;
 vec3 glow=texture(halo,p).rgb*.70+texture(wideHalo,p).rgb*(.30+portal*.60);
 // Outward lens drag follows the conduit, leaving wider blue residuals
 // between rings instead of increasing the exposure of their white cores.
 vec3 conduitBleed=vec3(0.);
 if(portal>.001)for(int i=1;i<=5;i++){
  float age=float(i),weight=exp(-age*.48);
  vec2 past=.5+(p-.5)*exp(-age*.026*portal);
  vec3 exposed=texture(source,past).rgb;
  conduitBleed+=max(exposed-vec3(.18),0.)*vec3(.22,.48,.72)*weight;
 }
 col+=conduitBleed*portal*.34;
 col+=glow*bloom*(1.15+pulse*.85);
 // Exposed silver: a steep toe, open blue mids, and broad chalk-white cores.
 // Grade before emulsion so wear never drags every highlight into grey.
 col=1.-exp(-max(col-vec3(.012),0.)*1.78);
 col=smoothstep(vec3(.018),vec3(.91),col);
 float dye=dot(col,vec3(.24,.62,.14));
 col=mix(vec3(dye)*vec3(.94,.99,1.05),col,.74);
 float silver=smoothstep(.45,.87,dye);
 col=mix(col,vec3(dye)*vec3(.98,1.015,1.025),silver*.72);
 float emulsion=noise(p*vec2(53.,38.)+time*.025);
 col*=1.-filmWear*(.025+emulsion*.075);
 float luminance=dot(col,vec3(.22,.65,.13));
 float scan=.965+.035*cos(p.y*size.y*3.14159265);
 col*=mix(1.,scan,min(1.,crt*.62));
 float triad=mod(floor(p.x*size.x),3.);
 vec3 phosphor=triad<1.?vec3(1.,.79,.76):triad<2.?vec3(.79,1.,.79):vec3(.77,.81,1.);
 col*=mix(vec3(1.),phosphor,min(.5,crt*.14));
 float frame=floor(time*24.);
 float fine=hash(floor(p*size)+vec2(frame*17.31,frame*7.67))-.5;
 float coarse=noise(p*size*.22+frame*3.14)-.5;
 col+=(fine*.070+coarse*.057)*grain*(.35+.65*luminance);
 // Vertical burn lines, gate weave, dusty emulsion and a worn optical edge.
 float vertical=noise(vec2(floor(p.x*size.x*.4),frame*.08));
 col-=(vertical-.5)*.042*grain;
 float dust=step(.9990,hash(floor(p*size*.5)+floor(frame*.14)));
 col+=dust*grain*.18;
 float vignette=1.-smoothstep(.20,.73,length(q))*min(.60,.14+.05*crt);
 col*=vignette;
 // The optical field can refract; its physical frame stays square and aligned.
 float border=smoothstep(0.,.008,edgeDistance);
 if(dither>.001){
  float luminance=dot(col,vec3(.24,.62,.14));
  float threshold=bayer(uv*size/1.35);
  float value=floor(clamp(luminance,0.,1.)*5.+threshold)/5.;
  vec3 screened=col*(value+.025)/max(luminance,.025);
  // Screening lives in exposed midtones. The shadow stock and white cores
  // remain continuous, without a checkerboard over the entire viewport.
  float midtone=smoothstep(.035,.14,luminance)*(1.-smoothstep(.72,.92,luminance));
  col=mix(col,screened,dither*midtone);
 }
 // A dense blue print black, with grain visible within it, as in the source.
 // The conduit opens around a quiet optical pocket for its caption. It is
 // part of the exposure, with no rectangle or seam over the moving rings.
 // GLSL pow is undefined for negative bases, even with an even exponent.
 float copyPocket=exp(-pow(abs((uv.y-.225)/.16),4.))*exp(-pow(abs((uv.x-.5)/.40),6.));
 float browPocket=exp(-pow(abs((uv.y-.815)/.048),2.))*exp(-pow(abs((uv.x-.5)/.38),6.));
 col*=1.-portal*max(copyPocket*.87,browPocket*.78);
 col=max(col,vec3(.022,.032,.048)*(.86+emulsion*.32)+vec3(fine*.005)*grain);
 col*=border;
 outColor=vec4(clamp(col,0.,1.),1.);
}`,
  shaders = { vertex, world, combine, blur, finish },
  DURATION = 116,
  chapters = [
    {
      start: 0,
      end: 14,
      name: "01 / A MARKET MOVES",
      slug: "origin",
      rest: 4,
      runway: 2.6,
    },
    {
      start: 14,
      end: 27,
      name: "02 / FIND THE CAUSE",
      slug: "noise",
      rest: 24,
      runway: 3.6,
    },
    {
      start: 27,
      end: 38,
      name: "03 / BENEATH THE PRICE",
      slug: "screen",
      rest: 32,
      runway: 2.8,
    },
    {
      start: 38,
      end: 44,
      name: "04 / SEPARATE THE READINGS",
      slug: "resolve",
      rest: 41,
      runway: 2,
    },
    {
      start: 44,
      end: 61,
      name: "05 / FIVE AGENT PERSPECTIVES",
      slug: "swarm",
      rest: 58,
      runway: 4,
    },
    {
      start: 61,
      end: 68,
      name: "06 / QUESTION THE MOVE",
      slug: "isolate",
      rest: 64,
      runway: 2,
    },
    {
      start: 68,
      end: 85,
      name: "07 / WEIGH THE EVIDENCE",
      slug: "evidence",
      rest: 80,
      runway: 3.6,
    },
    {
      start: 85,
      end: 93,
      name: "08 / FOLLOW THE OWNERSHIP",
      slug: "detail",
      rest: 89,
      runway: 2.6,
    },
    {
      start: 93,
      end: 104,
      name: "09 / FORM THE SIGNAL",
      slug: "lock",
      rest: 99,
      runway: 3,
    },
    {
      start: 104,
      end: 116,
      name: "10 / ACT ON THE READING",
      slug: "signal",
      rest: 110,
      runway: 2.8,
    },
  ],
  SCROLL_VIEWS = chapters.reduce((i, l) => i + l.runway, 0);
function scrollToClock(i) {
  const l = clamp(i) * SCROLL_VIEWS;
  let n = 0;
  for (const o of chapters) {
    if (l <= n + o.runway)
      return o.start + clamp((l - n) / o.runway) * (o.end - o.start);
    n += o.runway;
  }
  return DURATION;
}
function clockToScroll(i) {
  const l = clamp(i, 0, DURATION);
  let n = 0;
  for (const o of chapters) {
    if (l <= o.end)
      return (
        (n + o.runway * clamp((l - o.start) / (o.end - o.start))) / SCROLL_VIEWS
      );
    n += o.runway;
  }
  return 1;
}
const clamp = (i, l = 0, n = 1) => Math.max(l, Math.min(n, i)),
  ease = (i) => ((i = clamp(i)), i * i * i * (i * (i * 6 - 15) + 10));
function pulse(i, l, n = 1) {
  const o = i - l;
  return o < 0 ? Math.exp(o * 5) * n : Math.exp(-o * 1.05) * n;
}
const ramp = (i, l, n) => ease((i - l) / (n - l)),
  envelope = (i, l, n, o, c) => ramp(i, l, n) * (1 - ramp(i, o, c));
function timeline(i) {
  const l = clamp(i, 0, DURATION),
    n = Math.min(l, DURATION - 1e-5),
    o = chapters.findIndex((R) => n >= R.start && n < R.end),
    c = chapters[o],
    a = (n - c.start) / (c.end - c.start),
    s =
      n < 38
        ? ramp(n, 8, 19)
        : n < 61
          ? ramp(n, 40, 49)
          : n < 93
            ? ramp(n, 63, 73)
            : ramp(n, 94, 106),
    h = n < 38 ? 0 : n < 61 ? 1 : n < 93 ? 2 : 13,
    y = n < 38 ? 1 : n < 61 ? 2 : n < 93 ? 13 : 3,
    k = envelope(n, 23, 30, 36, 44),
    w = envelope(n, 43, 49, 59, 65),
    E = envelope(n, 66, 73, 81, 88),
    K = envelope(n, 82, 87, 91, 97),
    Y = ramp(n, 91, 101),
    j = envelope(n, 35, 39, 43, 49),
    b = envelope(n, 59, 62, 66, 71),
    q = clamp(
      0.08 +
        Math.sin(Math.PI * s) * 0.48 +
        j * 0.52 +
        K * 0.45 +
        envelope(n, 93, 96, 103, 109) * 0.3,
      0,
      0.85,
    ),
    F = envelope(n, 14, 18, 25, 31),
    T = typeof innerWidth < "u" && innerWidth < 700;
  return {
    clock: l,
    index: o,
    time: n * 0.32,
    phase: 0,
    progress: a,
    morph: s,
    wordA: h,
    wordB: y,
    shape: 0,
    paper: 0,
    motion: 0.14 + k * 0.85 + Math.sin(Math.PI * s) * 0.35 + K * 0.3 + b * 0.2,
    stretch: 0,
    spread: 0,
    focus: 0,
    link: 0,
    fieldScale: 1.1,
    zoom: 1.02,
    center: [0, 0.12],
    typeOffset: [
      (T ? 0 : 0.6) * envelope(n, 64, 72, 81, 87),
      0.27 * F + (T ? 0.34 : 0.39) * envelope(n, 64, 72, 81, 87),
    ],
    typeScale: 1 + 0.5 * F + E * (T ? 1.95 : 1.8),
    pulse:
      pulse(n, 12, 0.45) +
      pulse(n, 28.6, 0.6) +
      pulse(n, 42, 0.35) +
      pulse(n, 62, 0.16) +
      pulse(n, 71, 0.35) +
      pulse(n, 94.5, 0.55) +
      pulse(n, 105, 0.4),
    reveal: 0.92 + Math.sin(n * 0.25) * 0.04,
    interference: envelope(n, 5, 16, 40, 49),
    portal: k,
    dive: ramp(n, 23, 40) * 8,
    swarm: w,
    planes: 0,
    evidence: 0,
    detail: 0,
    lock: Y,
    sampling: j,
    dropout: b,
    dither: q,
    filmWear: 0.7,
    grooves:
      0.24 +
      0.55 * envelope(n, 37, 46, 60, 66) +
      0.38 * envelope(n, 66, 73, 84, 90) +
      0.32 * ramp(n, 98, 109),
    nano: envelope(n, 23, 30, 41, 49),
    converge: 0,
    wordVisibility: clamp(
      1 -
        0.4 * F -
        0.99 * k -
        0.85 * j -
        0.98 * envelope(n, 42, 47, 66, 72) -
        0.94 * envelope(n, 81, 85, 92, 97) -
        0.45 * envelope(n, 73, 77, 81, 85),
    ),
    vapor: 0.12 + Math.sin(Math.PI * s) * 0.86,
    captionTravel:
      1 -
      ramp(n, c.start, c.start + (c.end - c.start) * 0.25) -
      ramp(n, c.end - (c.end - c.start) * 0.2, c.end),
    reading: clamp(Math.floor(ramp(n, 69, 84) * 5), 0, 4),
  };
}
const agentPositions = [
    [0.1, 0.32],
    [0.1, 0.382],
    [0.1, 0.444],
    [0.1, 0.506],
    [0.1, 0.568],
  ],
  evidencePositions = agentPositions;
function instrumentState(i, l = !1) {
  const n = ramp(i, 39, 46),
    o = ramp(i, 70.5, 79),
    c = envelope(i, 82, 87, 91, 97),
    a = ramp(i, 94, 106);
  return {
    split: n,
    weigh: o,
    close: c,
    merge: a,
    alpha: envelope(i, 35, 43, 83, 88) * (1 - c),
    left: l ? 0.38 : 0.24,
    right: l ? 0.71 : 0.76,
    ys: agentPositions.map(([, s]) => s),
    scan: ramp(i, 44, 60),
  };
}
function activityState(i) {
  const l = ramp(i, 16.5, 22.5),
    n = 0.16 * ramp(i, 0, 8) + 0.84 * l,
    o = profiles.ghost.series,
    c = n * (o.length - 1),
    a = Math.floor(c),
    s = o[a] + (o[Math.min(a + 1, o.length - 1)] - o[a]) * (c - a),
    h = (y) => 0.595 - ((y - o[0]) / (o.at(-1) - o[0])) * 0.295;
  return { rising: l, arrival: n, value: s, tip: [0.1 + 0.8 * n, h(s)], y: h };
}
function paintMarks(i, l, n, o, c = {}) {
  if ((i.clearRect(0, 0, n, o), c.lab)) return;
  const a = l.clock,
    s = Math.min(n, o),
    h = n / o < 0.85,
    y = profiles.ghost,
    k = instrumentState(a, h),
    w = (T, R = 1, M = 1.2) => {
      ((i.strokeStyle = `rgba(151,209,239,${R})`),
        (i.lineWidth = M),
        i.beginPath(),
        T.forEach(([B, O], P) =>
          P ? i.lineTo(B * n, O * o) : i.moveTo(B * n, O * o),
        ),
        i.stroke());
    },
    E = (T, R, M = 1, B = 2) => {
      ((i.fillStyle = `rgba(205,236,250,${M})`),
        i.beginPath(),
        i.arc(T * n, R * o, B, 0, Math.PI * 2),
        i.fill());
    },
    K = (T, R, M, B = 1) => {
      ((i.fillStyle = `rgba(186,215,228,${B})`),
        (i.font = `${Math.round(s * (h ? 0.014 : 0.013))}px ui-monospace,monospace`),
        i.fillText(T, R * n, M * o));
    },
    Y = envelope(a, 0, 3, 23, 31);
  if (Y > 0.001) {
    const T = ramp(a, 23, 28),
      R = activityState(a),
      M = R.arrival,
      B = y.series;
    for (let O = 0; O < 5; O++) {
      const P = Y * (O === 0 ? 0.9 : T * 0.22),
        V = [];
      for (let z = 0; z < B.length; z++) {
        const oe = z / (B.length - 1);
        if (oe > M) break;
        const te = 0.1 + oe * 0.8,
          Z = R.y(B[z]) + T * (O - 2) * 0.028;
        V.push([te, Z]);
      }
      if (V.length) {
        (V.push([R.tip[0], R.tip[1] + T * (O - 2) * 0.028]),
          w(V, P, O === 0 ? 2 : 0.8));
        const z = V.at(-1);
        E(...z, P, O === 0 ? 3 : 1);
      }
    }
    for (let O = 0; O < 190; O++) {
      const P = O / 189;
      if (P > M) break;
      const V = P * (B.length - 1),
        z = Math.floor(V),
        oe = B[z] + (B[Math.min(z + 1, B.length - 1)] - B[z]) * (V - z),
        te = 0.1 + P * 0.8,
        Z = R.y(oe),
        ie = i.createLinearGradient(te * n, Z * o, te, 0.6 * o);
      (ie.addColorStop(0, `rgba(151,209,239,${Y * 0.1})`),
        ie.addColorStop(0.35, `rgba(151,209,239,${Y * 0.035})`),
        ie.addColorStop(1, "rgba(151,209,239,0)"),
        (i.strokeStyle = ie),
        (i.lineWidth = 0.7),
        i.beginPath(),
        i.moveTo(te * n, (Z + 0.007) * o),
        i.lineTo(te * n, 0.6 * o),
        i.stroke());
    }
  }
  const j = k.alpha;
  if (j > 0.001) {
    const T = c.agent ?? -1,
      R = envelope(a, 60, 63, 66, 70);
    for (let M = 0; M < 5; M++) {
      const { split: B, weigh: O, left: P, right: V } = k,
        z = 0.45 + (k.ys[M] - 0.45) * B,
        oe = c.agentWeights,
        te = oe ? Array.from(oe.slice(5, 10)).reduce((X, se) => X + se, 0) : 0,
        Z = oe ? 1 - (te - oe[5 + M]) * 0.83 : T >= 0 && T !== M ? 0.17 : 1,
        ie = j * Z * (M === 4 ? 1 : 1 - R * 0.8),
        fe = y.agents[M] / 100,
        le = V - (V - P) * O * (1 - fe * weights[M] * 2.1),
        he = T === M ? 1 : ramp(a, 47 + M * 2, 48.4 + M * 2);
      w(
        [
          [P, z],
          [V, z],
        ],
        ie * 0.14,
        0.7,
      );
      let re = [];
      if (M === 0)
        re = y.series.map((X, se) => [
          P + (se / (y.series.length - 1)) * (le - P),
          z - ((0.028 * (X - 13)) / 61) * he,
        ]);
      else if (M === 2) {
        for (let X = 0; X < 100; X++) {
          const se = P + (X / 100) * (le - P);
          w(
            [
              [se, z],
              [se, z - (X < 31 ? 0.021 : 0.01) * (0.25 + 0.75 * he)],
            ],
            ie * (X < 31 ? 0.95 : 0.23),
            h ? 1 : 1.4,
          );
        }
        re = [
          [P, z],
          [le, z],
        ];
      } else {
        const X = M === 1 ? y.liquidity / 25e4 : fe,
          se = (X * (1 - O) + O) * he;
        if (
          ((re = [
            [P, z - 0.014],
            [P + (le - P) * se, z - 0.014],
          ]),
          w(re, ie, 2.3),
          M === 1)
        ) {
          const G = P + (le - P) * 0.4;
          w(
            [
              [G, z - 0.026],
              [G, z + 0.007],
            ],
            ie * 0.45,
          );
        }
      }
      w(re, ie, M === 0 ? 1.6 : 0.8);
      const I = P + (le - P) * he;
      E(I, z - 0.01, ie * 0.8, 1.8);
      const H = ramp(a, 70 + M, 73 + M),
        W = 0.83,
        N = 0.46;
      if (O > 0.01) {
        const X = [];
        for (let se = 0; se <= 24; se++) {
          const G = (se / 24) * H,
            pe = ease(G);
          X.push([le + (W - le) * G, z + (N - z) * pe]);
        }
        w(X, ie * O * 0.4, 0.8);
      }
    }
    k.weigh > 0.02 && E(0.83, 0.46, j * k.weigh, 3);
  }
  const b = envelope(a, 82, 87, 92, 97);
  if (b > 0.001) {
    const T = ramp(a, 83, 88),
      R = s * (h ? 0.029 : 0.038),
      M = R * 0.35,
      B = 10 * (R + M) - M,
      O = n * 0.5 - B / 2,
      P = o * 0.29;
    for (let V = 0; V < 100; V++) {
      const z = O + (V % 10) * (R + M),
        oe = P + Math.floor(V / 10) * (R + M),
        te = V < 31,
        Z = n * (k.left + (V / 100) * (k.right - k.left)),
        ie = o * 0.444;
      ((i.fillStyle = `rgba(${te ? "133,185,216" : "45,79,102"},${b * (te ? 0.78 : 0.52)})`),
        i.fillRect(
          Z + (z - Z) * T,
          ie + (oe - ie) * T,
          R * (0.3 + 0.7 * T),
          R,
        ));
    }
  }
  const q = ramp(a, 93, 105),
    F = envelope(a, 94, 99, 115, 116.5);
  if (F > 0.001)
    for (let M = 0; M < 5; M++) {
      const B = [];
      for (let O = 0; O <= 90; O++) {
        const P = O / 90,
          V = 0.1 + P * (0.9 - 0.1),
          z =
            0.57 +
            (M - 2) * 0.035 * (1 - q) +
            Math.sin(P * 10 + M) * 0.025 * (1 - q);
        B.push([V, z]);
      }
      (w(B, F * (0.24 + q * 0.12), 0.8),
        E(0.9, 0.57 + (M - 2) * 0.035 * (1 - q), F, 1.4));
    }
}
function distanceTransform(i, l, n, o) {
  const c = new Float32Array(l * n),
    a = new Float32Array(Math.max(l, n)),
    s = new Int32Array(a.length),
    h = new Float32Array(a.length + 1),
    y = new Float32Array(a.length);
  function k(w) {
    let E = 0;
    ((s[0] = 0), (h[0] = -1 / 0), (h[1] = 1 / 0));
    for (let K = 1; K < w; K++) {
      let Y = s[E],
        j = (a[K] + K * K - (a[Y] + Y * Y)) / (2 * K - 2 * Y);
      for (; j <= h[E]; )
        (E--,
          (Y = s[E]),
          (j = (a[K] + K * K - (a[Y] + Y * Y)) / (2 * K - 2 * Y)));
      ((s[++E] = K), (h[E] = j), (h[E + 1] = 1 / 0));
    }
    E = 0;
    for (let K = 0; K < w; K++) {
      for (; h[E + 1] < K; ) E++;
      const Y = K - s[E];
      y[K] = Y * Y + a[s[E]];
    }
  }
  for (let w = 0; w < l; w++) {
    for (let E = 0; E < n; E++) a[E] = i[E * l + w] === o ? 0 : 1e6;
    k(n);
    for (let E = 0; E < n; E++) c[E * l + w] = y[E];
  }
  for (let w = 0; w < n; w++) {
    for (let E = 0; E < l; E++) a[E] = c[w * l + E];
    k(l);
    for (let E = 0; E < l; E++) c[w * l + E] = Math.sqrt(y[E]);
  }
  return c;
}
class SignalRenderer {
  constructor(l, n = {}) {
    if (
      ((this.canvas = l),
      (this.options = {
        grain: 0.56,
        bloom: 1.05,
        trails: 0.95,
        chromatic: 0.74,
        crt: 0.7,
        ...n,
      }),
      (this.mobile =
        matchMedia("(pointer: coarse)").matches || innerWidth < 700),
      (this.gl = l.getContext("webgl2", {
        alpha: !1,
        antialias: !1,
        preserveDrawingBuffer: !!n.capture,
        powerPreference: this.mobile ? "low-power" : "high-performance",
      })),
      !this.gl)
    )
      throw new Error("This artwork needs WebGL 2.");
    const o = this.gl;
    ((this.float = !!o.getExtension("EXT_color_buffer_float")),
      (this.programs = {}));
    for (const a of ["world", "combine", "blur", "finish"])
      this.programs[a] = this.compile(shaders.vertex, shaders[a]);
    ((this.vao = o.createVertexArray()), o.bindVertexArray(this.vao));
    const c = o.createBuffer();
    (o.bindBuffer(o.ARRAY_BUFFER, c),
      o.bufferData(
        o.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        o.STATIC_DRAW,
      ),
      (this.buffer = c));
    for (const a of Object.values(this.programs)) {
      const s = o.getAttribLocation(a, "position");
      (o.enableVertexAttribArray(s),
        o.vertexAttribPointer(s, 2, o.FLOAT, !1, 0, 0));
    }
    ((this.glyphs = o.createTexture()),
      (this.words = [
        "DISCOVER",
        "NOISE",
        "AGENTS",
        "SIGNAL",
        "EKO",
        "FLOW",
        "DEPTH",
        "HOLDERS",
        "STORY",
        "RISK",
        "GHOST",
        "BYTE",
        "FROG",
        "EVIDENCE",
        "CLARITY",
        "EKO",
      ]),
      this.setWords(),
      (this.marks = o.createTexture()),
      (this.markCanvas = document.createElement("canvas")),
      (this.markContext = this.markCanvas.getContext("2d")),
      (this.interaction = {
        pointer: [0.5, 0.5],
        pointerForce: 0,
        agent: -1,
        lab: !1,
        token: 0,
      }),
      (this.targets = []),
      this.resize(),
      (this.time = 0));
  }
  compile(l, n) {
    const o = this.gl,
      c = (y, k) => {
        const w = o.createShader(y);
        if (
          (o.shaderSource(w, k),
          o.compileShader(w),
          !o.getShaderParameter(w, o.COMPILE_STATUS))
        )
          throw new Error(o.getShaderInfoLog(w));
        return w;
      },
      a = c(o.VERTEX_SHADER, l),
      s = c(o.FRAGMENT_SHADER, n),
      h = o.createProgram();
    if (
      (o.attachShader(h, a),
      o.attachShader(h, s),
      o.linkProgram(h),
      o.deleteShader(a),
      o.deleteShader(s),
      !o.getProgramParameter(h, o.LINK_STATUS))
    )
      throw new Error(o.getProgramInfoLog(h));
    return ((h.locations = new Map()), h);
  }
  setWords(l = this.words[1]) {
    ((this.words[1] = String(l).trim().toUpperCase().slice(0, 10) || "SIGNAL"),
      (this.glyphReady = new Set()),
      (this.glyphCell = document.createElement("canvas")),
      (this.glyphCell.width = 256),
      (this.glyphCell.height = 128),
      (this.glyphContext = this.glyphCell.getContext("2d", {
        willReadFrequently: !0,
      })));
    const n = this.gl;
    n.bindTexture(n.TEXTURE_2D, this.glyphs);
    const o = new Uint8Array(1024 * 512).fill(255);
    (n.texImage2D(
      n.TEXTURE_2D,
      0,
      n.R8,
      1024,
      512,
      0,
      n.RED,
      n.UNSIGNED_BYTE,
      o,
    ),
      this.textureSettings(),
      this.prepareGlyph(0),
      this.prepareGlyph(1));
    const c = [2, 13, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 5],
      a = () => {
        this.destroyed ||
          !c.length ||
          (this.prepareGlyph(c.shift()), (this.glyphTask = setTimeout(a, 25)));
      };
    this.glyphTask = setTimeout(a, 100);
  }
  prepareGlyph(l) {
    if (this.glyphReady.has(l)) return;
    const n = this.glyphContext;
    (n.clearRect(0, 0, 256, 128),
      (n.font = "900 78px Impact, Arial Black, sans-serif"));
    const o = Math.min(1, 224 / n.measureText(this.words[l]).width);
    ((n.font = `900 ${78 * o}px Impact, Arial Black, sans-serif`),
      (n.textAlign = "center"),
      (n.textBaseline = "middle"),
      (n.fillStyle = "#fff"),
      n.fillText(this.words[l], 128, 66));
    const c = n.getImageData(0, 0, 256, 128),
      a = new Uint8Array(256 * 128);
    for (let w = 0; w < a.length; w++) a[w] = c.data[w * 4 + 3] > 127 ? 1 : 0;
    const s = distanceTransform(a, 256, 128, 1),
      h = distanceTransform(a, 256, 128, 0),
      y = new Uint8Array(a.length);
    for (let w = 0; w < a.length; w++)
      y[w] = Math.round(clamp(0.5 + (s[w] - h[w]) / 64) * 255);
    const k = this.gl;
    (k.bindTexture(k.TEXTURE_2D, this.glyphs),
      k.texSubImage2D(
        k.TEXTURE_2D,
        0,
        (l % 4) * 256,
        Math.floor(l / 4) * 128,
        256,
        128,
        k.RED,
        k.UNSIGNED_BYTE,
        y,
      ),
      this.glyphReady.add(l));
  }
  textureSettings() {
    const l = this.gl;
    (l.texParameteri(l.TEXTURE_2D, l.TEXTURE_MIN_FILTER, l.LINEAR),
      l.texParameteri(l.TEXTURE_2D, l.TEXTURE_MAG_FILTER, l.LINEAR),
      l.texParameteri(l.TEXTURE_2D, l.TEXTURE_WRAP_S, l.CLAMP_TO_EDGE),
      l.texParameteri(l.TEXTURE_2D, l.TEXTURE_WRAP_T, l.CLAMP_TO_EDGE));
  }
  target(l, n) {
    const o = this.gl,
      c = o.createTexture(),
      a = o.createFramebuffer();
    if (
      (o.bindTexture(o.TEXTURE_2D, c),
      this.textureSettings(),
      o.texImage2D(
        o.TEXTURE_2D,
        0,
        this.float ? o.RGBA16F : o.RGBA,
        l,
        n,
        0,
        o.RGBA,
        this.float ? o.HALF_FLOAT : o.UNSIGNED_BYTE,
        null,
      ),
      o.bindFramebuffer(o.FRAMEBUFFER, a),
      o.framebufferTexture2D(
        o.FRAMEBUFFER,
        o.COLOR_ATTACHMENT0,
        o.TEXTURE_2D,
        c,
        0,
      ),
      o.checkFramebufferStatus(o.FRAMEBUFFER) !== o.FRAMEBUFFER_COMPLETE)
    )
      throw new Error("Incomplete optical framebuffer");
    return { texture: c, fbo: a, width: l, height: n };
  }
  resize(l = this.canvas.clientWidth, n = this.canvas.clientHeight) {
    const o = this.gl;
    this.mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 700;
    const c = Math.min(devicePixelRatio || 1, this.mobile ? 1 : 1.5),
      a = Math.round(l * c),
      s = Math.round(n * c);
    if (
      this.canvas.width === a &&
      this.canvas.height === s &&
      this.targets.length
    )
      return !1;
    ((this.canvas.width = a), (this.canvas.height = s));
    const h = Math.min(
      1,
      (this.mobile ? 540 : 1152) / this.canvas.width,
      (this.mobile ? 720 : 800) / this.canvas.height,
    );
    ((this.width = Math.max(2, Math.round(this.canvas.width * h))),
      (this.height = Math.max(2, Math.round(this.canvas.height * h))),
      (this.markCanvas.width = this.width),
      (this.markCanvas.height = this.height),
      o.bindTexture(o.TEXTURE_2D, this.marks),
      o.texImage2D(
        o.TEXTURE_2D,
        0,
        o.RGBA,
        this.width,
        this.height,
        0,
        o.RGBA,
        o.UNSIGNED_BYTE,
        null,
      ),
      this.textureSettings());
    for (const w of this.targets)
      (o.deleteTexture(w.texture), o.deleteFramebuffer(w.fbo));
    ((this.frames = Array.from({ length: this.mobile ? 2 : 4 }, () =>
      this.target(this.width, this.height),
    )),
      (this.combined = this.target(this.width, this.height)));
    const y = Math.max(2, Math.round(this.width / 4)),
      k = Math.max(2, Math.round(this.height / 4));
    return (
      (this.halos = [this.target(y, k), this.target(y, k)]),
      this.mobile ||
        this.halos.push(
          this.target(
            Math.max(2, Math.round(y / 3)),
            Math.max(2, Math.round(k / 3)),
          ),
          this.target(
            Math.max(2, Math.round(y / 3)),
            Math.max(2, Math.round(k / 3)),
          ),
        ),
      (this.targets = [...this.frames, this.combined, ...this.halos]),
      !0
    );
  }
  draw(l, n, o, c = {}) {
    const a = this.gl,
      s = this.programs[l];
    (a.useProgram(s),
      a.bindVertexArray(this.vao),
      a.bindFramebuffer(a.FRAMEBUFFER, n?.fbo || null),
      a.viewport(
        0,
        0,
        n?.width || this.canvas.width,
        n?.height || this.canvas.height,
      ));
    const h = (k) => (
      s.locations.has(k) || s.locations.set(k, a.getUniformLocation(s, k)),
      s.locations.get(k)
    );
    for (const [k, w] of Object.entries(o)) {
      const E = h(k);
      w instanceof Float32Array
        ? a.uniform1fv(E, w)
        : Array.isArray(w)
          ? a.uniform2fv(E, w)
          : a.uniform1f(E, w);
    }
    let y = 0;
    for (const [k, w] of Object.entries(c))
      (a.activeTexture(a.TEXTURE0 + y),
        a.bindTexture(a.TEXTURE_2D, w),
        a.uniform1i(h(k), y++));
    a.drawArrays(a.TRIANGLE_STRIP, 0, 4);
  }
  wordWeights(l) {
    const n = timeline(l),
      o = new Float32Array(16);
    ((o[n.wordA] += 1 - n.morph), (o[n.wordB] += n.morph));
    const c = this.interaction;
    if (c.agentWeights) {
      const a = n.swarm;
      for (let s = 0; s < 16; s++)
        o[s] = o[s] * (1 - a) + c.agentWeights[s] * a;
    }
    if (c.lab) {
      const a = clamp(c.tailProgress || 0);
      (o.fill(0), (o[3] = 1 - a), (o[4] = a));
    }
    return o;
  }
  pose(l) {
    const n = timeline(l);
    n.weights = this.wordWeights(l);
    const o = this.interaction;
    ((n.surface = 0),
      (n.fieldLine = o.fieldLine ?? -1),
      (n.fieldProgress = o.fieldProgress || 0),
      (n.fieldTuning = o.token || 0),
      (n.fieldFlash = o.fieldFlash || 0),
      (n.readingWeights =
        o.readingWeights || new Float32Array([1, 1, 1, 1, 1])));
    const c = Math.max(...n.weights);
    if (
      ((n.vapor = Math.max(n.vapor, Math.sin(Math.PI * (1 - c)) * 0.9)),
      this.interaction.lab)
    ) {
      ((n.interference = 0.5),
        (n.center = [0, 0.05]),
        (n.reveal = 1),
        (n.wordVisibility = 1),
        (n.portal =
          n.converge =
          n.nano =
          n.vapor =
          n.planes =
          n.evidence =
          n.detail =
          n.lock =
          n.sampling =
          n.dropout =
          n.dither =
            0));
      const a = clamp(this.interaction.tailProgress || 0);
      ((n.typeOffset = [a * 0.45, 0.18]),
        (n.typeScale = 1.15 - a * 0.25),
        (n.dither = 0.42),
        (n.vapor = 0.18 + Math.sin(a * Math.PI) * 0.25),
        (n.grooves = 0.9),
        (n.time += a * 6),
        (n.wordVisibility = 0.85));
    }
    if (o.lab) {
      const a = clamp(o.tailProgress || 0);
      ((n.surface = 1 - a * 0.5),
        (n.interference = 0.08),
        (n.grooves = 0.18),
        (n.wordVisibility = 0.85 * a));
    }
    return n;
  }
  renderAt(l) {
    this.time = clamp(l, 0, DURATION - 1e-5);
    const n = this.pose(this.time),
      o = this.gl,
      c = this.mobile ? [0, 0.2] : [0, 0.075, 0.2, 0.42];
    for (let a = 0; a < this.frames.length; a++) {
      const s = this.pose(Math.max(0, this.time - c[a]));
      for (let h = 0; h < 16; h++) s.weights[h] > 1e-5 && this.prepareGlyph(h);
      (paintMarks(
        this.markContext,
        s,
        this.width,
        this.height,
        this.interaction,
      ),
        o.bindTexture(o.TEXTURE_2D, this.marks),
        o.texSubImage2D(
          o.TEXTURE_2D,
          0,
          0,
          0,
          o.RGBA,
          o.UNSIGNED_BYTE,
          this.markCanvas,
        ),
        this.draw(
          "world",
          this.frames[a],
          {
            ...s,
            size: [this.width, this.height],
            pointer: this.interaction.pointer,
            pointerForce: this.interaction.pointerForce,
            activeAgent: this.interaction.agent,
          },
          { glyphs: this.glyphs, marks: this.marks },
        ));
    }
    return (
      this.draw(
        "combine",
        this.combined,
        { time: n.time, trails: this.options.trails, motion: n.motion },
        {
          frame0: this.frames[0].texture,
          frame1: this.frames[1].texture,
          frame2: (this.frames[2] || this.frames[1]).texture,
          frame3: (this.frames[3] || this.frames[1]).texture,
        },
      ),
      this.draw(
        "blur",
        this.halos[0],
        { direction: [1 / this.halos[0].width, 0], extract: 1 },
        { source: this.combined.texture },
      ),
      this.draw(
        "blur",
        this.halos[1],
        { direction: [0, 1 / this.halos[1].height], extract: 0 },
        { source: this.halos[0].texture },
      ),
      this.mobile ||
        (this.draw(
          "blur",
          this.halos[2],
          {
            direction: [(1 + n.pulse * 3) / this.halos[2].width, 0],
            extract: 0,
          },
          { source: this.halos[1].texture },
        ),
        this.draw(
          "blur",
          this.halos[3],
          { direction: [0, 1 / this.halos[3].height], extract: 0 },
          { source: this.halos[2].texture },
        )),
      this.draw(
        "finish",
        null,
        {
          ...this.options,
          time: n.time,
          size: [this.canvas.width, this.canvas.height],
          motion: n.motion,
          pulse: n.pulse,
          nano: n.nano,
          dive: n.dive,
          dither: n.dither,
          filmWear: n.filmWear,
          dropout: n.dropout,
          portal: n.portal,
        },
        {
          source: this.combined.texture,
          halo: this.halos[1].texture,
          wideHalo: (this.halos[3] || this.halos[1]).texture,
        },
      ),
      this.canvas.dispatchEvent(
        new CustomEvent("signalframe", {
          detail: {
            time: this.time,
            chapter: chapters.find(
              (a) => this.time >= a.start && this.time < a.end,
            ),
          },
        }),
      ),
      0
    );
  }
  setOptions(l) {
    (Object.assign(this.options, l), this.renderAt(this.time));
  }
  destroy() {
    ((this.destroyed = !0), clearTimeout(this.glyphTask));
    const l = this.gl;
    for (const n of this.targets)
      (l.deleteTexture(n.texture), l.deleteFramebuffer(n.fbo));
    for (const n of Object.values(this.programs)) l.deleteProgram(n);
    (l.deleteTexture(this.glyphs),
      l.deleteTexture(this.marks),
      l.deleteBuffer(this.buffer),
      l.deleteVertexArray(this.vao));
  }
}
const weights = [0.3, 0.25, 0.2, 0.15, 0.1],
  roles = ["Momentum", "Liquidity", "Holders", "Narrative", "Risk"],
  profiles = {
    ghost: {
      symbol: "$GHOST",
      liquidity: 218e3,
      volume: 412e3,
      pressure: 63,
      concentration: 31,
      agents: [86, 80, 58, 70, 44],
      series: [
        13, 15, 14, 18, 19, 17, 22, 20, 25, 23, 22, 26, 30, 29, 31, 34, 30, 33,
        38, 42, 40, 44, 41, 46, 50, 48, 51, 49, 54, 59, 55, 57, 62, 60, 64, 68,
        66, 71, 69, 74,
      ],
      reason:
        "Momentum and liquidity support the reading. Concentrated supply keeps it in monitoring territory.",
    },
    byte: {
      symbol: "$BYTE",
      liquidity: 48e3,
      volume: 132e3,
      pressure: 55,
      concentration: 42,
      agents: [68, 39, 65, 48, 37],
      series: [
        30, 32, 31, 36, 34, 40, 38, 42, 46, 44, 43, 47, 45, 42, 41, 44, 40, 39,
        41, 38, 42, 40, 38, 41, 39, 43, 41, 40, 44, 41, 42, 40, 39, 42, 40, 41,
        43, 41, 42, 44,
      ],
      reason:
        "Momentum has support, but thin liquidity and weak risk readings limit the composite signal.",
    },
    frog: {
      symbol: "$FROG",
      liquidity: 17e3,
      volume: 31e4,
      pressure: 47,
      concentration: 68,
      agents: [31, 25, 28, 52, 18],
      series: [
        18, 22, 27, 26, 33, 41, 49, 58, 70, 82, 77, 69, 74, 65, 59, 54, 58, 50,
        45, 48, 40, 35, 39, 33, 31, 29, 34, 28, 24, 26, 22, 24, 21, 25, 23, 20,
        22, 19, 21, 18,
      ],
      reason:
        "Activity alone is insufficient. Low liquidity and concentrated holdings outweigh the attention.",
    },
  };

export { SignalRenderer, scrollToClock, SCROLL_VIEWS, DURATION, chapters };
