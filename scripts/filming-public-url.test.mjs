import {test} from 'node:test';import assert from 'node:assert/strict';
import {filmingPublicUrls} from './filming-public-url.mjs';
const old='https://tunnel.example.test',publicOrigin='https://service.example.test';
test('new messages use the canonical origin and preserve the same secret fragment',()=>{
    const urls=filmingPublicUrls(old,publicOrigin);assert.equal(urls.link(old+'/s#token=abc_-123'),publicOrigin+'/filming/s#token=abc_-123');assert.equal(urls.link(publicOrigin+'/filming/s#token=abc_-123'),publicOrigin+'/filming/s#token=abc_-123');
});
test('existing tunnel clients and non-browser clients keep their request headers',()=>{
    const urls=filmingPublicUrls(old,publicOrigin);for(const headers of [{origin:old,cookie:'session=test'}, {authorization:'Bearer test'}])assert.deepEqual(urls.headers(headers),headers);
});
test('only the explicitly configured public origin is normalized; foreign origins remain rejected by the API',()=>{
    const urls=filmingPublicUrls(old,publicOrigin),headers={origin:publicOrigin,cookie:'session=test'};assert.deepEqual(urls.headers(headers),{origin:old,cookie:'session=test'});assert.equal(headers.origin,publicOrigin);assert.equal(urls.headers({origin:'https://evil.example.test'}).origin,'https://evil.example.test');
});
test('no secret-bearing foreign link or untrusted public base can be forwarded',()=>{
    assert.throws(()=>filmingPublicUrls(old,publicOrigin).link('https://evil.example.test/s#token=test'));
    for(const origin of ['http://service.example.test','https://user:pass@service.example.test','https://service.example.test/path','https://service.example.test?key=x'])assert.throws(()=>filmingPublicUrls(old,origin));
});
