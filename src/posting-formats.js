const catalog=require('../contracts/posting-formats.json');
const renderGoals={'instagram-reel-p':9/16,'instagram-reel-l':16/9,'youtube-short-p':9/16,'youtube-short-l':16/9,'youtube-video-l':16/9,'tiktok-p':9/16,'tiktok-l':16/9};
for(const [platform,{types}] of Object.entries(catalog.platforms))for(const type of types.filter(t=>t.kind==='video'))for(const aspect of type.ratios){
 const [w,h]=catalog.aspects[aspect];renderGoals[`${platform}-${type.id}-${aspect.replace(':','x')}`]=w/h;
}
function postingGoalRatio(goal){
 if(Object.hasOwn(renderGoals,goal))return renderGoals[goal];
 const match=/^custom-(\d{3,4})x(\d{3,4})$/.exec(String(goal||''));
 if(!match)return null;
 const [w,h]=match.slice(1).map(Number);
 return w>=320&&h>=320&&w<=3840&&h<=3840&&w/h>=.25&&w/h<=4?w/h:null;
}
module.exports={renderGoals,postingGoalRatio};
