// Independent test arithmetic. sRGB / D65 Lab, unit-weight CIEDE2000,
// OKLab interpolation, and WCAG relative luminance. Production tokens are literals.
function linear(v) {
  v/=255;
  return v<=.04045?v/12.92:((v+.055)/1.055)**2.4
}

function rgb(h) {
  return h.slice(1).match(/../g).map(x=>parseInt(x,16))
}

function lab(h) {
  const [r,g,b]=rgb(h).map(linear);
  const f=t=>t>216/24389?Math.cbrt(t):(24389/27*t+16)/116;
  const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047),
    y=f(.2126729*r+.7151522*g+.072175*b),
    z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)]
}

function deltaLab(first,second) {
  const [L1,a1,b1]=first,
    [L2,a2,b2]=second,
    radiansPerDegree=Math.PI/180,
    degreesPerRadian=180/Math.PI,
    C1=Math.hypot(a1,b1),
    C2=Math.hypot(a2,b2),
    C=(C1+C2)/2,
    chromaAdjustment=.5*(1-Math.sqrt(C**7/(C**7+25**7))),
    adjustedA1=(1+chromaAdjustment)*a1,
    adjustedA2=(1+chromaAdjustment)*a2,
    c1=Math.hypot(adjustedA1,b1),
    c2=Math.hypot(adjustedA2,b2),
    ang=(a,b)=>(Math.atan2(b,a)*degreesPerRadian+360)%360,
    hue1=ang(adjustedA1,b1),
    hue2=ang(adjustedA2,b2),
    deltaLightness=L2-L1,
    deltaChroma=c2-c1;
  let hueDifference=hue2-hue1;
  if(c1*c2===0)hueDifference=0;
  else if(hueDifference>180)hueDifference-=360;
  else if(hueDifference< -180)hueDifference+=360;
  const deltaHue=2*Math.sqrt(c1*c2)*Math.sin(hueDifference*radiansPerDegree/2),
    meanLightness=(L1+L2)/2,
    meanChroma=(c1+c2)/2;
  let meanHue=hue1+hue2;
  if(c1*c2!==0)meanHue=Math.abs(hue1-hue2)<=180?meanHue/2:(meanHue<360?(meanHue+360)/2:(meanHue-360)/2);
  const hueCurve=1-.17*Math.cos((meanHue-30)*radiansPerDegree)+.24*Math.cos(2*meanHue*radiansPerDegree)+.32*Math.cos((3*meanHue+6)*radiansPerDegree)-.20*Math.cos((4*meanHue-63)*radiansPerDegree),
    lightnessWeight=1+.015*(meanLightness-50)**2/Math.sqrt(20+(meanLightness-50)**2),
    chromaWeight=1+.045*meanChroma,
    hueWeight=1+.015*meanChroma*hueCurve,
    rotationTerm=-2*Math.sqrt(meanChroma**7/(meanChroma**7+25**7))*Math.sin(60*Math.exp(-(((meanHue-275)/25)**2))*radiansPerDegree);
  return Math.sqrt((deltaLightness/lightnessWeight)**2+(deltaChroma/chromaWeight)**2+(deltaHue/hueWeight)**2+rotationTerm*(deltaChroma/chromaWeight)*(deltaHue/hueWeight))
}

function oklab(h) {
  const [r,g,b]=rgb(h).map(linear),
    l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),
    m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),
    s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s]
}

function fromok([L,a,b]) {
  const l=(L+.3963377774*a+.2158037573*b)**3,
    m=(L-.1055613458*a-.0638541728*b)**3,
    s=(L-.0894841775*a-1.291485548*b)**3;
  return '#'+[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(v=>Math.round(255*Math.max(0,Math.min(1,v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055)))).map(v=>v.toString(16).padStart(2,'0')).join('')
}

function ramp(t) {
  const a=oklab('#636363'),
    b=oklab('#E8ECF0');
  return fromok(a.map((v,i)=>v+(b[i]-v)*t))
}

function contrast(a,b) {
  const lum=h=> {
    const v=rgb(h).map(linear);
    return .2126*v[0]+.7152*v[1]+.0722*v[2]
  }
  ;
  const x=lum(a),
    y=lum(b);
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)
}

function de(first,second) {
  return deltaLab(lab(first),lab(second))
}
export { lab, deltaLab, de, ramp, contrast, rgb };
