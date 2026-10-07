import {parentPort} from 'node:worker_threads';
import {renderLocalDemTile} from './raster-dem-to-pmtiles.mjs';
parentPort.on('message',async({id,job,maxSourcePixels,maxTileBytes})=>{
  parentPort.postMessage({id,type:'started'});
  try{
    const tile=await renderLocalDemTile(job,{maxSourcePixels,maxTileBytes});
    const bytes=Uint8Array.from(tile.data);
    parentPort.postMessage({id,type:'result',bytes},[bytes.buffer]);
  }catch(error){parentPort.postMessage({id,type:'error',error:String(error?.message??error)});}
});
