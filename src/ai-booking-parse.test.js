const test=require('node:test');
const assert=require('node:assert/strict');
const {parseModelReply}=require('./ai-booking');
test('weak-model answers are still usable when the JSON is fenced or surrounded by prose, and plain text still fails closed',()=>{
  const json='{"reply":"Great, a wedding!","orderPatch":[]}';
  assert.equal(parseModelReply(json).reply,'Great, a wedding!');
  assert.equal(parseModelReply('```json\n'+json+'\n```').reply,'Great, a wedding!');
  assert.equal(parseModelReply('Sure! Here you go: '+json+' Hope that helps.').reply,'Great, a wedding!');
  assert.equal(parseModelReply('How many guests are you expecting?'),null);
  assert.equal(parseModelReply(''),null);
  assert.equal(parseModelReply('x'),null);
});
