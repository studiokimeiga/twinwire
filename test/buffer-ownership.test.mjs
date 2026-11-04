import test from 'node:test';
import assert from 'node:assert/strict';
import {pair} from './helpers.mjs';
import {encodeFrame,decodeFrame} from '../dist/core/protocol.js';
import {ReplicaSender,ReplicaReceiver,encodeReplica,decodeReplica} from '../dist/netcode/replication.js';

test('queued state snapshots a Node Buffer instead of retaining its mutable slice view',()=>{
  const p=pair(),bytes=Buffer.from([1,2]);let received;
  p.b.onState=state=>{received=[...state.data];};
  p.a.sendState(1,bytes,p.now);bytes.fill(9);p.advance();
  assert.deepEqual(received,[1,2]);
});

test('decoded frame payload owns its bytes when the encoded input is a pooled Buffer',()=>{
  const packet=Buffer.from(encodeFrame({kind:1,epoch:1,stream:1,seq:1,time:0,payload:new Uint8Array([1,2])}));
  const decoded=decodeFrame(packet);packet.fill(9);
  assert.deepEqual([...decoded.payload],[1,2]);
});

test('replica sender owns Node Buffer records across caller mutations',()=>{
  const sender=new ReplicaSender(),source=Buffer.from([1,2]);
  sender.publish(1,1,source);source.fill(9);
  assert.deepEqual([...sender.due(0)[0].data],[1,2]);
});

test('replica receiver owns Node Buffer records across caller mutations',()=>{
  const receiver=new ReplicaReceiver(),record=Buffer.from([3,4]);
  receiver.apply({id:1,generation:1,revision:1,deleted:false,data:record});record.fill(9);
  assert.deepEqual([...receiver.get(1)],[3,4]);
});

test('decoded replica payload owns its bytes when the encoded packet is a Buffer',()=>{
  const packet=Buffer.from(encodeReplica({id:1,generation:1,revision:1,deleted:false,data:new Uint8Array([5,6])}));
  const decoded=decodeReplica(packet);packet.fill(9);
  assert.deepEqual([...decoded.data],[5,6]);
});
