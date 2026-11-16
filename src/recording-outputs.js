const ratio=(width,height)=>{
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)return null;
 let a=width,b=height;while(b)[a,b]=[b,a%b];return `${width/a}:${height/a}`;
};
function captureOutputs(value){
 if(value===undefined)return [{key:'main'}];
 if(!Array.isArray(value)||value.length<1||value.length>2)throw Object.assign(Error('Choose one or two recording outputs.'),{status:400});
 return value.map((item,index)=>{
  if(item?.key!==(index===0?'main':'portrait'))throw Object.assign(Error('Invalid recording output order.'),{status:400});
  const {width,height}=item;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192)throw Object.assign(Error('Invalid recording output dimensions.'),{status:400});
  return {key:item.key,width,height};
 });
}
function outputView(row){
 const part=row.parts?.find(part=>ratio(part.width,part.height));
 const width=row.width||part?.width,height=row.height||part?.height;
 return {id:String(row._id),key:row.outputKey||'main',width:width||null,height:height||null,aspectRatio:ratio(width,height)};
}
function recordingGroups(rows,serialize){
 const children=new Map();
 for(const row of rows)if(row.parentRecordingId){const key=String(row.parentRecordingId);if(!children.has(key))children.set(key,[]);children.get(key).push(row);}
 return rows.filter(row=>!row.parentRecordingId).map(row=>{
  const item=serialize(row),extra=children.get(String(row._id))||[];
  if(!extra.length)return item;
  const outputs=[item,...extra.map(serialize)];
  return {...item,outputs,bytes:outputs.reduce((n,out)=>n+(out.bytes||0),0),durationSec:Math.max(...outputs.map(out=>out.durationSec||0)),
   canRemove:outputs.every(out=>out.canRemove),canRetry:outputs.some(out=>out.canRetry),canPreview:outputs.some(out=>out.canPreview),
   status:outputs.every(out=>['ready','partial'].includes(out.status))?(outputs.some(out=>out.status==='partial')?'partial':'ready'):outputs.find(out=>!['ready','partial'].includes(out.status))?.status||item.status};
 });
}
module.exports={ratio,captureOutputs,outputView,recordingGroups};
