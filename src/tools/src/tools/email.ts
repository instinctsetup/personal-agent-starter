import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error(`${key} is required`);return value;};
export class EmailTools {
  async send(to:string,subject:string,text:string) {
    const port=Number(process.env.SMTP_PORT??465);
    const transport=nodemailer.createTransport({host:required('SMTP_HOST'),port,secure:port===465,requireTLS:port!==465,auth:{user:required('SMTP_USER'),pass:required('SMTP_PASSWORD')},connectionTimeout:15000,logger:false,debug:false});
    try { const result=await transport.sendMail({from:required('MAIL_FROM'),to,subject,text,disableFileAccess:true,disableUrlAccess:true});return {messageId:result.messageId,accepted:result.accepted}; } finally{transport.close();}
  }
  async verification(sender:string,subjectContains:string,since:string) {
    if(!sender.includes('@')||!subjectContains||!Number.isFinite(Date.parse(since))) throw new Error('Exact sender, subject fragment and ISO start time required');
    const client=new ImapFlow({host:required('IMAP_HOST'),port:Number(process.env.IMAP_PORT??993),secure:true,auth:{user:required('IMAP_USER'),pass:required('IMAP_PASSWORD')},logger:false});
    await client.connect();
    try {
      const lock=await client.getMailboxLock('INBOX');
      try {
        const ids=await client.search({from:sender,since:new Date(since)},{uid:true}); if(!ids||!ids.length) return [];
        const found=[];
        for await(const message of client.fetch(ids.slice(-10),{source:true,uid:true,internalDate:true},{uid:true})) {
          if(!message.source||!(message.internalDate instanceof Date)||message.internalDate<new Date(since))continue;
          const mail=await simpleParser(message.source);
          if(!mail.from?.value.some(v=>v.address?.toLowerCase()===sender.toLowerCase())||!mail.subject?.includes(subjectContains))continue;
          const text=mail.text??'';
          found.push({uid:message.uid,subject:mail.subject,codes:text.match(/\b\d{4,8}\b/g)??[],links:text.match(/https:\/\/[^\s<>"']+/g)??[]});
        }
        return found;
      }finally{lock.release();}
    } finally {await client.logout();}
  }
}
