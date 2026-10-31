const sections={
 'recordings':'Recordings','collections':'Collections','work-elements':'Work Elements','dj-work-type':'DJ Work Type','dj-service-builder':'DJ Service Builder',
 'live-stream':'Live stream','live-archive':'Live Recordings','clients':'Registered Clients','bookings':'Booking requests','testimonials':"Clients’ Testimonials",'meetings':'Meeting requests',
 'youtube':'YouTube','gallery':'Gallery','prices':'Events, Services & Equipment','transactions':'Transactions','availability':'Availability','vouchers':'Vouchers',
 'ai-administrator':'Echo AI Administrator','ai-configuration':'ECHO AI Configuration','ai-billing':'Echo AI billing','seasonal-theme':'Seasonal theme',
};
const normalize=value=>String(value).toLowerCase().replace(/[’']/g,'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
const aliases=new Map(Object.entries(sections).flatMap(([key,label])=>[[normalize(key),key],[normalize(label),key]]));
for(const [label,key] of Object.entries({'music archive':'recordings','work elements':'work-elements','registered clients':'clients','booking requests':'bookings','services':'prices','equipment':'prices','ai configuration':'ai-configuration','ai administrator':'ai-administrator','ai billing':'ai-billing','live archive':'live-archive'}))aliases.set(label,key);
function navigationIntent(command){
 const text=normalize(command).replace(/[.!?]+$/,'').replace(/^(?:please\s+)?(?:can|could|would) you\s+/,'').replace(/^please\s+/,'').replace(/^i (?:want|would like) (?:you )?to\s+/,'');
 const match=text.match(/^(?:open|show(?: me)?|go to|navigate to|take me to|switch to|access|view)\s+(?:the\s+)?(.+?)\s*(?:please)?$/);
 if(!match)return null;
 const name=match[1].replace(/["“”‘]/g,'').replace(/\s+(?:tab|page|section|screen)$/,'').trim();
 return aliases.get(name)||null;
}
module.exports={sections,navigationIntent};
