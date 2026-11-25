const {createEmailDesign,renderEmailLayout}=require('../notification-email-design');
const {escapeHtml}=require('./text');

// Mailbox messages share branding with notifications, but keep the exact text
// written by the admin and invite replies instead of showing an automated footer.
function createMailboxEmailRenderer({designs=createEmailDesign()}={}){
 return async({subject,text})=>renderEmailLayout({subject,text,automated:false,contentHtml:`<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`},await designs.get()).html;
}
module.exports={createMailboxEmailRenderer};
