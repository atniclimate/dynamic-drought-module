// Synthetic geometry for the existing generic parser; no live geometry or routes.
// Metadata receipts: 2026-10-07 Lead 1 /0?f=json, field1=cat, field2=prob.
// precip SHA256 547953231f105348e8e6eadfec9aec7f2c248f0c2339a865d8266af8b7c20553
// temp SHA256 52695582302e38969e0e8e2d0c80952066714df8a421490dc7562c9c65b46da5
// This pins source evidence in tests only, not a production palette/admission.
export const CPC_SEASONAL_CLASSES = [
  ...[90,80,70,60,50,40,33].map(prob=>({cat:'Above',prob,label:`Above, ${prob}%`})),
  ...[33,40].map(prob=>({cat:'Normal',prob,label:`Near Normal, ${prob}%`})),
  ...[33,40,50,60,70,80,90].map(prob=>({cat:'Below',prob,label:`Below, ${prob}%`})),
  {cat:'EC',prob:33,label:'Equal Chances'}
] ;
export const CPC_RENDERER_COLORS = {
  precip:[[40,83,0,255],[40,96,10,255],[0,120,20,255],[0,150,32,255],[72,180,48,255],[149,206,127,255],[179,217,171,255],[215,217,217,255],[160,160,160,255],[240,212,147,255],[216,167,79,255],[187,109,51,255],[155,80,49,255],[147,70,57,255],[128,64,0,255],[79,47,47,255],[0,0,0,0]],
  temp:[[112,33,0,255],[145,38,0,255],[179,46,5,255],[201,59,26,255],[218,87,49,255],[227,139,75,255],[231,177,104,255],[215,217,217,255],[160,160,160,255],[191,203,228,255],[160,192,223,255],[119,181,226,255],[56,159,220,255],[0,93,161,255],[46,33,111,255],[34,24,82,255],[255,255,255,0]]
};
export const CPC_OUTLINE = {color:[110,110,110,255],width:1};
export function cpcSeasonalPolygons() {
  return {type:'FeatureCollection',features:CPC_SEASONAL_CLASSES.map((entry,index)=>{
    const x=-125+index;
    const ring=[[x,40],[x+0.5,40],[x+0.5,40.5],[x,40.5],[x,40]];
    return {type:'Feature',properties:{cat:entry.cat,prob:entry.prob,
      valid_seas:'SON 2026',fcst_date:Date.UTC(2026,8,1)},
      geometry:index%2 ? {type:'MultiPolygon',coordinates:[[ring]]} : {type:'Polygon',coordinates:[ring]}};
  })};
}
export function cpcSeasonalBody(arm) {
  if(arm==='polygons') return cpcSeasonalPolygons();
  if(arm==='emptyCollection') return {type:'FeatureCollection',features:[]};
  if(arm==='emptyObject') return {};
  if(arm==='noFeatures') return {type:'FeatureCollection'};
  if(arm==='arcgisError') return {error:{code:500,message:'Fixture failure'}};
  if(arm==='lbEnvelope') return {status:'error',messages:['Could not access any server machines.']};
  if(arm==='partial') return {...cpcSeasonalPolygons(),exceededTransferLimit:true};
  if(arm==='partialEmpty') return {type:'FeatureCollection',features:[],exceededTransferLimit:true};
  if(arm==='attributeOnly') {
    const body=cpcSeasonalPolygons();
    body.features.forEach(feature=>{feature.geometry=null;});
    return body;
  }
  throw new Error(`Unknown fixture arm: ${arm}`);
}
