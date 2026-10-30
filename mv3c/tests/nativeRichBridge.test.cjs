const assert = require('node:assert/strict');
const { test } = require('node:test');
const {extractProviderBinding,saveProviderBinding,nativeEndpoint,readBoundSnapshot,normalizeBoundNativeSnapshot} = require('../nativeRichBridge.cjs');
const meta={user_id:'user_a123',thread_id:'convo_abc123',run_id:'message_123456'};
const req={response_metadata:{chat2api:{request_id:'req_abc123456',native_content:{version:1}}}};
const config={endpoints:{custom:[{name:'chat2api',baseURL:'https://api.example.com/v1',apiKey:'private-secret'}]}};
test('bind only to real model response metadata, never user content',()=>{
 assert.deepEqual(extractProviderBinding(req,meta),{user:'user_a123',conversationId:'convo_abc123',messageId:'message_123456',requestId:'req_abc123456'});
 for(const bad of [{content:'chat2api req_abc123456'},
 {response_metadata:{chat2api:{request_id:'req_abc123456'}}},
 {response_metadata:{chat2api:{request_id:'req_abc123456',native_content:{version:2}}}}])
  assert.equal(extractProviderBinding(bad,meta),null);
 assert.equal(extractProviderBinding(req,{...meta,user_id:null}),null);
});
test('no arbitrary upstream or requester-selected URLs',()=>{
 assert.deepEqual(nativeEndpoint(config,'req_abc123456'),{url:'https://api.example.com/v1/native-content/req_abc123456',token:'private-secret'});
 assert.equal(nativeEndpoint(config,'https://evil.com/x'),null);
 assert.equal(nativeEndpoint({endpoints:{custom:[{name:'chat2api',baseURL:'https://u:p@evil.com/v1',apiKey:'secret'}]}},'req_abc123456'),null);
});
test('binding is owner- and message-scoped',async()=>{
 const records=new Map();
 const collection={
  updateOne:async(q,u)=>records.set([q.user,q.conversationId,q.messageId].join('/'),u.$set),
  findOne:async q=>{const v=records.get([q.user,q.conversationId,q.messageId].join('/'));return v?.expiresAt>new Date()?v:null;},
 };
 assert.equal(await saveProviderBinding(collection,req,meta),true);
 const payload={version:1,revision:2,assets:[],root:{tag:'p',text:'hi'}};
 let calls=0;
 const fetchImpl=async(url,opts)=>{calls++;assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer private-secret');assert.match(url,/req_abc123456$/);return new Response(JSON.stringify(payload));};
 assert.equal(await readBoundSnapshot({collection,user:'user_wrong',conversationId:meta.thread_id,messageId:meta.run_id,config,fetchImpl}),null);
 assert.equal(calls,0);
 assert.deepEqual(await readBoundSnapshot({collection,user:meta.user_id,conversationId:meta.thread_id,messageId:meta.run_id,config,fetchImpl}),payload);
 assert.equal(calls,1);
});

test('only archive URLs on the configured HTTPS provider host can be upgraded',()=>{
 const owned='http://api.example.com/api/media/med_12345678/token987654321';
 const archiveFile='http://api.example.com/api/generated-files/file_12345678/token987654321';
 const unsafe='http://evil.example.com/api/media/med_12345678/token987654321';
 const payload={version:1,revision:3,
   root:{tag:'div',children:[{tag:'img',media_index:0}]},
   assets:[owned,unsafe,'http://api.example.com:8080/api/media/med_12345678/token987654321'],
   files:[{filename:'plan.zip',status:'ready',bytes:1044,url:archiveFile}]};
 const result=normalizeBoundNativeSnapshot(payload,config);
 assert.equal(result.assets[0],'https://api.example.com/api/media/med_12345678/token987654321');
 assert.equal(result.assets[1],unsafe,'cross-domain media is never rewritten');
 assert.equal(result.assets[2],payload.assets[2],'non-default port not rewritten');
 assert.equal(result.files[0].url,
   'https://api.example.com/api/generated-files/file_12345678/token987654321');
 assert.equal(payload.assets[0],owned,'do not mutate the model snapshot');
 for(const bad of [
   'http://api.example.com/api/media/med_12345678/token987654321?secret=1',
   'http://api.example.com/path/to/untrusted',
   'http://api.example.com.evil.invalid/api/media/med_12345678/token987654321',
 ]) {
   assert.equal(normalizeBoundNativeSnapshot({assets:[bad]},config).assets[0],bad);
 }
 const local={endpoints:{custom:[{name:'chat2api',baseURL:'http://chat2api/v1',apiKey:'secret'}]}};
 assert.equal(normalizeBoundNativeSnapshot({assets:[owned]},local).assets[0],owned,
   'HTTP-only upstream never triggers an unsupported HTTPS rewrite');
});
