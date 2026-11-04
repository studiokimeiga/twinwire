import test from 'node:test';
import assert from 'node:assert/strict';
import {datagramConnection} from '../dist/core/webtransport.js';
import {acceptWebTransport} from '../dist/server/webtransport.js';

// Characterize the real optional provider's JS lifecycle without needing its unavailable Ubuntu22 native binary.
// Its onClose owns the session-level readable controllers and throws if a consumer cancelled one first.
const {HttpWTSession}=await import(new URL('./session.js',import.meta.resolve('@fails-components/webtransport')));
function providerSession(){
  const session=new HttpWTSession({parentobj:{}});session.onReady({});let nativeError;
  session.close=()=>{try{session.onClose({errorcode:0,error:''});}catch(error){nativeError=error;}};
  return {session,get nativeError(){return nativeError;}};
}

test('SDK datagram teardown lets the provider close its own session controllers without a process-level exception',async()=>{
  const fixture=providerSession();
  const link=datagramConnection(fixture.session,1100,{open(){},data(){},closed(){},error(){}});
  link.close();
  assert.equal(fixture.nativeError,undefined);
  await fixture.session.closed;
  assert.equal(fixture.session.state,'closed');
});

test('binding timeout releases the pending provider reader without cancelling its controller before native close',async()=>{
  const fixture=providerSession();
  await acceptWebTransport(fixture.session,()=>assert.fail('unbound session'),{unreliableDatagrams:true,handshakeTimeoutMs:5});
  assert.equal(fixture.nativeError,undefined);
  await fixture.session.closed;
  assert.equal(fixture.session.state,'closed');
});
