export function filmingPublicUrls(internalOrigin,publicOrigin=internalOrigin) {
    const internal=new URL(internalOrigin).origin,external=new URL(publicOrigin);
    if(external.protocol!=='https:'||external.username||external.password||external.search||external.hash||!['','/'].includes(external.pathname))throw Error('Development public address must be an HTTPS origin');
    return {
        origin:external.origin,
        link(value){
            const url=new URL(value);
            if(![internal,external.origin].includes(url.origin))throw Error('Unexpected development link origin');
            url.protocol=external.protocol;url.host=external.host;url.pathname='/filming/s';return url.href;
        },
        headers(headers){return {...headers,...(headers.origin===external.origin?{origin:internal}:{})};},
    };
}
