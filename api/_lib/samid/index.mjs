// Generated from index.ts with Node 24 stripTypeScriptTypes; see README.md.
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
export class SamIdSignInError extends Error {
    constructor(){
        super('Sam ID sign-in could not be verified. Please try again.');
        this.name = 'SamIdSignInError';
    }
}
const cookieNames = [
    'samid-state',
    'samid-nonce',
    'samid-verifier'
];
const jwksByFetch = new WeakMap();
const clockToleranceSeconds = 30;
function encode(bytes) {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function randomValue() {
    return encode(crypto.getRandomValues(new Uint8Array(32)));
}
function formEncode(value) {
    return new URLSearchParams({
        value
    }).toString().slice('value='.length);
}
function sameRandomValue(a, b) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(a) || !/^[A-Za-z0-9_-]{43}$/.test(b)) return false;
    let difference = 0;
    for(let i = 0; i < 43; i++)difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}
function validateUrl(value) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && [
        'localhost',
        '127.0.0.1',
        '[::1]'
    ].includes(url.hostname))) {
        throw new SamIdSignInError();
    }
    return url;
}
function remoteKeys(issuer, fetcher) {
    let cache = jwksByFetch.get(fetcher);
    if (!cache) {
        cache = new Map();
        jwksByFetch.set(fetcher, cache);
    }
    let keys = cache.get(issuer);
    if (!keys) {
        keys = createRemoteJWKSet(new URL(`${issuer}/jwks.json`), {
            [customFetch]: fetcher
        });
        cache.set(issuer, keys);
    }
    return keys;
}
export function createSamIdClient(configuration) {
    const issuer = configuration.issuer;
    const issuerUrl = validateUrl(issuer);
    if (issuerUrl.search || issuer.endsWith('/')) throw new SamIdSignInError();
    const fetcher = configuration.fetch ?? globalThis.fetch;
    function optionsFor(redirectUri, maxAge) {
        return {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: validateUrl(redirectUri).pathname,
            maxAge
        };
    }
    async function startSignIn({ clientId, redirectUri }) {
        if (!clientId) throw new SamIdSignInError();
        const options = optionsFor(redirectUri, 600);
        const state = randomValue();
        const nonce = randomValue();
        const verifier = randomValue();
        const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        for (const [index, value] of [
            state,
            nonce,
            verifier
        ].entries()){
            await configuration.cookies.set(cookieNames[index], value, options);
        }
        const url = new URL(`${issuer}/authorize`);
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: 'S256'
        }).toString();
        return url.toString();
    }
    async function finishSignIn(request, { clientId, clientSecret, redirectUri }) {
        const clearOptions = optionsFor(redirectUri, 0);
        try {
            if (!clientId || !clientSecret) throw new SamIdSignInError();
            const callback = new URL(request.url);
            const expected = validateUrl(redirectUri);
            if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw new SamIdSignInError();
            for (const [name, value] of expected.searchParams){
                if (callback.searchParams.getAll(name).length !== 1 || callback.searchParams.get(name) !== value) throw new SamIdSignInError();
            }
            if (callback.searchParams.has('error') || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length !== 1) throw new SamIdSignInError();
            const values = await Promise.all(cookieNames.map(async (name)=>{
                const cookie = await configuration.cookies.get(name);
                return typeof cookie === 'string' ? cookie : cookie?.value ?? '';
            }));
            const [state, nonce, verifier] = values;
            if (!sameRandomValue(state, callback.searchParams.get('state') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new SamIdSignInError();
            const code = callback.searchParams.get('code');
            if (!code) throw new SamIdSignInError();
            const response = await fetcher(`${issuer}/token`, {
                method: 'POST',
                cache: 'no-store',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret)}`)}`
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                    code_verifier: verifier
                })
            });
            if (!response.ok) throw new SamIdSignInError();
            const token = await response.json();
            if (typeof token !== 'object' || !token || !('id_token' in token) || typeof token.id_token !== 'string') throw new SamIdSignInError();
            const now = Math.floor(Date.now() / 1000);
            const { payload, protectedHeader } = await jwtVerify(token.id_token, remoteKeys(issuer, fetcher), {
                issuer,
                audience: clientId,
                algorithms: [
                    'ES256'
                ],
                currentDate: new Date(now * 1000),
                clockTolerance: clockToleranceSeconds,
                requiredClaims: [
                    'iss',
                    'sub',
                    'aud',
                    'iat',
                    'exp',
                    'nonce',
                    'auth_time',
                    'amr',
                    'email'
                ]
            });
            const audiences = typeof payload.aud === 'string' ? [
                payload.aud
            ] : payload.aud;
            if (!protectedHeader.kid || payload.sub !== 'sam' || !Array.isArray(audiences) || !audiences.every((audience)=>typeof audience === 'string' && audience.length > 0) || !audiences.includes(clientId) || payload.azp !== undefined && payload.azp !== clientId || audiences.length > 1 && payload.azp !== clientId || typeof payload.nonce !== 'string' || !sameRandomValue(nonce, payload.nonce) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + clockToleranceSeconds || payload.exp - payload.iat !== 300 || typeof payload.auth_time !== 'number' || !Number.isSafeInteger(payload.auth_time) || payload.auth_time < 0 || payload.auth_time > now + clockToleranceSeconds || payload.auth_time > payload.iat || !Array.isArray(payload.amr) || !payload.amr.every((method)=>typeof method === 'string') || !payload.amr.includes('webauthn') || typeof payload.email !== 'string' || !payload.email) throw new SamIdSignInError();
            return payload;
        } catch  {
            throw new SamIdSignInError();
        } finally{
            for (const name of cookieNames)await configuration.cookies.set(name, '', clearOptions);
        }
    }
    return {
        startSignIn,
        finishSignIn
    };
}
