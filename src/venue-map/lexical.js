// Word-based matching with spelling tolerance for venue names (same rules as the front end's venueLexical.js).
const words=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/['’‘]s\b/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);
function within(a,b,limit){
 if(Math.abs(a.length-b.length)>limit)return false;
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];let best=i;for(let j=1;j<=b.length;j++){next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));best=Math.min(best,next[j]);}if(best>limit)return false;row=next;}
 return row[b.length]<=limit;
}
const typo=(word,parts)=>word.length>=3&&parts.some(part=>{if(part[0]!==word[0])return false;const limit=word.length>5?2:1;return within(word,part,limit)||(part.length>word.length&&within(word,part.slice(0,word.length),limit));});
// 0 = no match. Every typed word must match a word of the name (whole word, start of a word, or a close misspelling).
function nameScore(name,query){
 const typed=words(query),parts=words(name);if(!typed.length||!parts.length)return 0;
 let score=0;
 for(const word of typed){if(parts.includes(word))score+=10;else if(parts.some(part=>part.startsWith(word)))score+=7;else if(typo(word,parts))score+=3;else return 0;}
 const joined=typed.join(' '),text=parts.join(' ');
 return score+(text===joined?30:text.startsWith(joined)?15:text.includes(joined)?8:0);
}
module.exports={nameScore};
