#!/usr/bin/env node
import { open,writeFile,realpath } from 'node:fs/promises';
import { resolve,dirname,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTerrainReceipt } from './lib/terrain-archive-receipts.mjs';
// Explicit, manual post-upload operation. No default service or gate invocation.
const names=['url','expected','out','timeout-ms','max-range-bytes','max-total-bytes','max-samples','max-receipt-bytes'];
try{
  const args={};const argv=process.argv.slice(2);
  for(let i=0;i<argv.length;i+=2){const key=argv[i]?.slice(2);if(!argv[i]?.startsWith('--') || !names.includes(key) || args[key]!==undefined || !argv[i+1])throw new Error('Invalid or duplicate argument');args[key]=argv[i+1];}
  if(names.some(name=>args[name]===undefined))throw new Error('All explicit URL, expected, out and limit arguments are required');
  const number=key=>{const value=Number(args[key]);if(!Number.isSafeInteger(value)||value<=0)throw new Error('Invalid '+key);return value;};
  const maxReceipt=number('max-receipt-bytes');const path=resolve(args.expected);
  const file=await open(path,'r');let text;
  try{
    const size=(await file.stat()).size;if(size>maxReceipt)throw new Error('Expected receipt file allowance exceeded');
    const chunks=[];let count=0;
    while(true){const buffer=Buffer.alloc(Math.min(65536,maxReceipt-count+1));const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;count+=bytesRead;if(count>maxReceipt)throw new Error('Expected receipt file allowance exceeded');chunks.push(buffer.subarray(0,bytesRead));}
    text=Buffer.concat(chunks).toString('utf8');
  }finally{await file.close();}
  const expected=JSON.parse(text);
  const output=resolve(args.out),parent=await realpath(dirname(output));
  const checkout=await realpath(fileURLToPath(new URL('..',import.meta.url)));const relation=relative(checkout,parent);
  if(relation==='' || (relation!=='..' && !relation.startsWith('..'+sep) && !isAbsolute(relation)))throw new Error('Write receipt outside the checkout');
  const receipt=await collectTerrainReceipt(args.url,expected,{timeoutMs:number('timeout-ms'),maxRangeBytes:number('max-range-bytes'),
    maxTotalBytes:number('max-total-bytes'),maxSamples:number('max-samples')});
  await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({ok:receipt.verdict.ok,reasons:receipt.verdict.reasons,output}));process.exitCode=receipt.verdict.ok?0:1;
}catch(error){console.error(String(error?.message??error));process.exitCode=2;}
